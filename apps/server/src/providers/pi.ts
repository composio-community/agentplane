import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ItemBody, RuntimeMode, ToolKind, Usage } from "@agentplane/contracts";
import { deferred, errorMessage, newId, truncate, withTimeout } from "../util.ts";
import { agentEnvironment, requireBinary } from "./detect.ts";
import type {
  AdapterEvent,
  OpenSessionOptions,
  ProviderAdapter,
  ProviderSession,
  RequestResponse,
} from "./types.ts";

/**
 * Pi (https://pi.dev) over `pi --mode rpc`: JSON lines on stdio. Pi has no
 * permission prompts of its own, so we load a tiny extension that asks via
 * Pi's extension UI protocol, which arrives here as `extension_ui_request`.
 */
const APPROVAL_EXTENSION = `\
import { readFileSync } from "node:fs";

// Written by Agentplane. Asks before tools run, per the thread's permissions.
const MODE_FILE = process.env.AGENTPLANE_PI_MODE_FILE;
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
const EDITS = new Set(["edit", "write"]);

function mode() {
  try {
    return readFileSync(MODE_FILE, "utf8").trim();
  } catch {
    return "supervised";
  }
}

export default function agentplaneApprovals(pi) {
  pi.on("tool_call", async (event, ctx) => {
    const current = mode();
    if (current === "full-access" || READ_ONLY.has(event.toolName)) return;
    if (current === "auto-edit" && EDITS.has(event.toolName)) return;
    const approved = await ctx.ui.confirm(
      "agentplane:" + event.toolName,
      JSON.stringify(event.input ?? {}),
    );
    if (!approved) return { block: true, reason: event.toolName + " was declined by the user." };
  });
}
`;

const MAX_OUTPUT = 20_000;
const TOOL_KINDS: Record<string, ToolKind> = {
  bash: "command",
  edit: "file_change",
  write: "file_change",
  read: "read",
  grep: "search",
  find: "search",
  ls: "search",
};

type PiMessage = { type: string; id?: string } & Record<string, unknown>;
type ToolCallBody = Extract<ItemBody, { kind: "tool_call" }>;
type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number };

type PiModel = { provider?: string; id?: string; name?: string };

/** Send a few RPC commands to a throwaway `pi --mode rpc` and collect the answers by id. */
async function piQuery(
  ids: string[],
  commands: Array<Record<string, unknown>>,
  extraEnv: Record<string, string>,
) {
  const executable = await requireBinary("pi", "Pi");
  const child = spawn(executable, ["--mode", "rpc", "--no-session", "--no-extensions"], {
    cwd: tmpdir(),
    env: { ...(await agentEnvironment()), ...extraEnv },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const answers = new Map<string, PiMessage>();
  const done = new Promise<Map<string, PiMessage>>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as PiMessage;
          if (message.type === "response" && message.id) answers.set(message.id, message);
        } catch {
          // Not JSON; ignore.
        }
        if (ids.every((id) => answers.has(id))) resolve(answers);
        newline = buffer.indexOf("\n");
      }
    });
    child.once("exit", () => reject(new Error("Pi exited before answering.")));
  });
  done.catch(() => undefined);
  for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
  try {
    return await withTimeout(done, 20_000);
  } finally {
    child.kill("SIGTERM");
  }
}

export function piAdapter(
  toolsDir: string,
  /** Extra environment for Pi, e.g. the user's OpenRouter key. */
  keyEnv: () => Promise<Record<string, string>> = async () => ({}),
): ProviderAdapter {
  return {
    provider: "pi",
    async listModels() {
      const answers = await piQuery(
        ["models", "state"],
        [
          { type: "get_available_models", id: "models" },
          { type: "get_state", id: "state" },
        ],
        await keyEnv(),
      );
      const data = answers.get("models")?.data as PiModel[] | { models?: PiModel[] } | undefined;
      const models = Array.isArray(data) ? data : (data?.models ?? []);
      const current = (answers.get("state")?.data as { model?: PiModel } | undefined)?.model;
      return models
        .filter((model) => model.id)
        .map((model) => {
          const id = model.provider ? `${model.provider}/${model.id}` : String(model.id);
          return {
            id,
            name: model.name ?? String(model.id),
            description: model.provider ?? null,
            isDefault: Boolean(
              current && current.id === model.id && current.provider === model.provider,
            ),
            aliases: [String(model.id)],
          };
        });
    },
    async openSession(options) {
      const executable = await requireBinary("pi", "Pi");
      const dir = join(toolsDir, "pi");
      await mkdir(dir, { recursive: true });
      const extension = join(dir, "agentplane-approvals.ts");
      await writeFile(extension, APPROVAL_EXTENSION, "utf8");
      const modeFile = join(dir, `mode-${newId()}`);
      await writeFile(modeFile, options.runtimeMode, "utf8");
      const env = { ...(await agentEnvironment()), ...(await keyEnv()), ...options.env };
      // Only resume a session file that still exists; otherwise start fresh and say so.
      const resumable = options.resumeId
        ? await stat(options.resumeId).then(
            () => true,
            () => false,
          )
        : false;
      const session = new PiSession(
        executable,
        extension,
        modeFile,
        env,
        { ...options, resumeId: resumable ? options.resumeId : null },
        options.resumeId,
      );
      options.signal?.addEventListener("abort", () => void session.close(), { once: true });
      try {
        await session.start();
      } catch (error) {
        await session.close();
        throw error;
      }
      return session;
    },
  };
}

class PiSession implements ProviderSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly emit: (event: AdapterEvent) => void;
  private readonly token = newId().slice(0, 8);
  private readonly requests = new Map<string, (message: PiMessage) => void>();
  private readonly pending = new Map<string, (response: RequestResponse) => void>();
  private readonly toolCalls = new Map<string, ToolCallBody>();
  private readonly texts = new Map<
    number,
    { id: string; kind: "assistant_message" | "reasoning"; text: string }
  >();
  private messageCount = 0;
  private nextRequest = 1;
  private turnActive = false;
  private interrupting = false;
  private turnHadOutput = false;
  private turnError: string | null = null;
  private totalsAtTurnStart: Totals | null = null;
  private stderrTail = "";
  private exited = false;

  constructor(
    executable: string,
    extension: string,
    private readonly modeFile: string,
    env: NodeJS.ProcessEnv,
    options: OpenSessionOptions,
    /** The session file we were asked to resume, even if it was missing. */
    private readonly requestedResume: string | null = null,
  ) {
    this.emit = options.emit;
    const args = [
      "--mode",
      "rpc",
      "--extension",
      extension,
      ...(options.model ? ["--model", options.model] : []),
      ...(options.resumeId ? ["--session", options.resumeId] : []),
    ];
    this.child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...env, AGENTPLANE_PI_MODE_FILE: modeFile },
      stdio: "pipe",
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4_000);
    });
    // Split on LF only: readline would also break on U+2028 inside JSON strings.
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim().startsWith("{")) {
          try {
            this.onMessage(JSON.parse(line) as PiMessage);
          } catch (error) {
            console.error("[pi] bad message:", errorMessage(error));
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    this.child.on("exit", (code, signal) => this.onExit(code, signal));
    this.child.on("error", (error) => this.onExit(null, null, error.message));
  }

  async start(): Promise<void> {
    const state = await this.request({ type: "get_state" });
    const data = (state.data ?? {}) as {
      model?: { provider?: string; id?: string };
      sessionFile?: string;
    };
    const stats = await this.request({ type: "get_session_stats" });
    const sessionFile =
      data.sessionFile ?? (stats.data as { sessionFile?: string } | undefined)?.sessionFile ?? null;
    this.totalsAtTurnStart = totalsOf(stats);
    this.emit({
      type: "session.ready",
      providerSessionId: sessionFile ?? `pi:${this.token}`,
      model: data.model?.id ? `${data.model.provider}/${data.model.id}` : null,
      ...(this.requestedResume ? { resumed: sessionFile === this.requestedResume } : {}),
    });
  }

  async startTurn(text: string): Promise<void> {
    this.turnActive = true;
    this.interrupting = false;
    this.turnHadOutput = false;
    this.turnError = null;
    const response = await this.request({ type: "prompt", message: text });
    if (response.success === false) {
      this.completeTurn("failed", String(response.error ?? "Pi rejected the prompt."));
    }
  }

  async interrupt(): Promise<void> {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    if (!this.turnActive) return;
    this.interrupting = true;
    await this.request({ type: "abort" });
  }

  respondToRequest(itemId: string, response: RequestResponse): void {
    const respond = this.pending.get(itemId);
    if (!respond) throw new Error("That request is no longer pending.");
    this.pending.delete(itemId);
    respond(response);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    // The approval extension reads this file at every tool call.
    await writeFile(this.modeFile, mode, "utf8");
  }

  async close(): Promise<void> {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    if (!this.exited) this.child.kill("SIGTERM");
    await rm(this.modeFile, { force: true });
  }

  // ─── Pi → us ───────────────────────────────────────────────────────────────

  private request(message: Record<string, unknown>): Promise<PiMessage> {
    if (this.exited) return Promise.reject(new Error("Pi has exited."));
    const id = `ap-${this.nextRequest++}`;
    const response = deferred<PiMessage>();
    this.requests.set(id, response.resolve);
    this.send({ ...message, id });
    return response.promise;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onMessage(message: PiMessage): void {
    switch (message.type) {
      case "response": {
        const resolve = message.id ? this.requests.get(message.id) : undefined;
        if (message.id) this.requests.delete(message.id);
        resolve?.(message);
        return;
      }
      case "message_start":
        if ((message.message as { role?: string } | undefined)?.role === "assistant") {
          this.messageCount += 1;
          this.texts.clear();
        }
        return;
      case "message_update":
        this.onAssistantEvent(message.assistantMessageEvent as Record<string, unknown> | undefined);
        return;
      case "turn_end": {
        const ended = message.message as { stopReason?: string; errorMessage?: string } | undefined;
        if (ended?.stopReason === "error")
          this.turnError = ended.errorMessage ?? "Pi hit an error.";
        return;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.onTool(message);
        return;
      case "extension_ui_request":
        this.onExtensionRequest(message);
        return;
      case "agent_settled":
        void this.settle();
        return;
      default:
        return;
    }
  }

  private onAssistantEvent(event: Record<string, unknown> | undefined): void {
    if (!event) return;
    const type = String(event.type);
    const index = Number(event.contentIndex ?? 0);
    const kind = type.startsWith("thinking")
      ? "reasoning"
      : type.startsWith("text")
        ? "assistant_message"
        : null;
    if (!kind) return;
    let segment = this.texts.get(index);
    if (!segment || segment.kind !== kind) {
      segment = { id: `${this.token}:${this.messageCount}:${index}:${kind}`, kind, text: "" };
      this.texts.set(index, segment);
    }
    if (type.endsWith("_delta")) segment.text += String(event.delta ?? "");
    if (type.endsWith("_end") && typeof event.content === "string") segment.text = event.content;
    if (!segment.text.trim()) return;
    this.turnHadOutput = true;
    const final = type.endsWith("_end");
    if (final) this.texts.delete(index);
    this.emit({
      type: "item",
      id: segment.id,
      body: { kind, text: segment.text, streaming: !final },
      final,
    });
  }

  private onTool(message: PiMessage): void {
    const id = String(message.toolCallId);
    const name = String(message.toolName ?? "tool");
    const args = (message.args ?? {}) as Record<string, unknown>;
    const previous = this.toolCalls.get(id);
    const result = (
      message.type === "tool_execution_end" ? message.result : message.partialResult
    ) as
      | { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> }
      | undefined;
    const output = result?.content
      ?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
      .join("\n");
    const patch = result?.details?.diff ?? result?.details?.patch;
    const body: ToolCallBody = {
      kind: "tool_call",
      tool: name,
      toolKind: TOOL_KINDS[name] ?? (name.includes("mcp") ? "mcp" : "other"),
      title: name.charAt(0).toUpperCase() + name.slice(1),
      detail: previous?.detail ?? toolDetail(args),
      output: output ? truncate(output, MAX_OUTPUT) : (previous?.output ?? null),
      diff:
        typeof patch === "string"
          ? truncate(patch, MAX_OUTPUT)
          : (previous?.diff ?? editDiff(name, args)),
      status:
        message.type !== "tool_execution_end"
          ? "running"
          : message.isError
            ? "failed"
            : "completed",
    };
    this.turnHadOutput = true;
    const final = message.type === "tool_execution_end";
    if (final) this.toolCalls.delete(id);
    else this.toolCalls.set(id, body);
    this.emit({ type: "item", id: `${this.token}:${id}`, body, final });
  }

  private onExtensionRequest(message: PiMessage): void {
    const requestId = String(message.id);
    const method = String(message.method);
    if (method !== "confirm") {
      // Fire-and-forget UI (status, notify) needs no answer; dialogs we can't show are cancelled.
      if (method === "select" || method === "input" || method === "editor") {
        this.send({ type: "extension_ui_response", id: requestId, cancelled: true });
      }
      return;
    }
    const title = String(message.title ?? "");
    const tool = title.startsWith("agentplane:") ? title.slice("agentplane:".length) : title;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(String(message.message ?? "{}")) as Record<string, unknown>;
    } catch {
      // Another extension's confirm; show its text as-is.
    }
    const kind = TOOL_KINDS[tool];
    const itemId = `approval:${this.token}:${requestId}`;
    const request: ItemBody = {
      kind: "approval",
      requestKind: kind === "command" ? "command" : kind === "file_change" ? "file_change" : "tool",
      tool,
      title: `Pi wants to use ${tool}`,
      detail: toolDetail(input) ?? (String(message.message ?? "") || null),
      diff: editDiff(tool, input),
      reason: null,
      status: "pending",
    };
    this.emit({ type: "item", id: itemId, body: request, final: true });
    this.pending.set(itemId, (response) => {
      const approved = response.kind === "approval" && response.decision !== "deny";
      this.send({ type: "extension_ui_response", id: requestId, confirmed: approved });
      this.emit({
        type: "item",
        id: itemId,
        body: {
          ...request,
          status: response.kind !== "approval" ? "cancelled" : approved ? "approved" : "denied",
        },
        final: true,
      });
    });
  }

  /** Pi says it's settled; confirm nothing is queued, then close the turn with usage. */
  private async settle(): Promise<void> {
    if (!this.turnActive) return;
    const state = await this.request({ type: "get_state" }).catch(() => null);
    const data = (state?.data ?? {}) as { isStreaming?: boolean; pendingMessageCount?: number };
    if (data.isStreaming || (data.pendingMessageCount ?? 0) > 0) return;
    this.completeTurn(
      this.interrupting ? "interrupted" : this.turnError ? "failed" : "completed",
      this.turnError,
    );
  }

  private async completeTurn(status: "completed" | "interrupted" | "failed", error: string | null) {
    if (!this.turnActive) return;
    this.turnActive = false;
    for (const segment of this.texts.values()) {
      if (segment.text.trim()) {
        this.emit({
          type: "item",
          id: segment.id,
          body: { kind: segment.kind, text: segment.text, streaming: false },
          final: true,
        });
      }
    }
    this.texts.clear();
    for (const [id, call] of this.toolCalls) {
      this.emit({
        type: "item",
        id: `${this.token}:${id}`,
        body: { ...call, status: "failed" },
        final: true,
      });
    }
    this.toolCalls.clear();
    const stats = await this.request({ type: "get_session_stats" }).catch(() => null);
    const totals = stats ? totalsOf(stats) : null;
    const start = this.totalsAtTurnStart;
    this.totalsAtTurnStart = totals;
    const usage: Usage | null =
      totals && start
        ? {
            inputTokens:
              totals.input +
              totals.cacheRead +
              totals.cacheWrite -
              (start.input + start.cacheRead + start.cacheWrite),
            outputTokens: totals.output - start.output,
            cachedInputTokens: totals.cacheRead - start.cacheRead,
          }
        : null;
    const silent = status === "completed" && !this.turnHadOutput;
    this.emit({
      type: "turn.completed",
      status: silent ? "failed" : status,
      usage,
      costUsd:
        typeof stats?.data === "object" ? ((stats.data as { cost?: number }).cost ?? null) : null,
      error: silent
        ? "Pi ended the turn without responding. Check `pi` is signed in and has a model."
        : error,
    });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, failure?: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    for (const resolve of this.requests.values())
      resolve({ type: "response", success: false, error: "Pi exited" });
    this.requests.clear();
    // 143 is 128 + SIGTERM: some CLIs report being stopped as an exit code.
    const clean = code === 0 || code === 143 || signal === "SIGTERM";
    const error = clean
      ? null
      : (failure ?? (this.stderrTail.trim().slice(-1_500) || `Pi exited with ${code ?? signal}`));
    if (this.turnActive) {
      this.turnActive = false;
      this.emit({
        type: "turn.completed",
        status: "failed",
        usage: null,
        costUsd: null,
        error: error ?? "Pi exited mid-turn.",
      });
    }
    this.emit({ type: "session.exited", error });
  }
}

function totalsOf(stats: PiMessage): Totals | null {
  const tokens = (stats.data as { tokens?: Partial<Totals> } | undefined)?.tokens;
  if (!tokens) return null;
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toolDetail(args: Record<string, unknown>): string | null {
  return (
    str(args.command) ??
    str(args.path) ??
    str(args.file_path) ??
    str(args.pattern) ??
    str(args.query)
  );
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function editDiff(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "write" && typeof args.content === "string") {
    return truncate(prefixLines(args.content, "+"), MAX_OUTPUT);
  }
  if (tool !== "edit") return null;
  const edits = Array.isArray(args.edits)
    ? (args.edits as Array<Record<string, unknown>>)
    : [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }];
  const hunks = edits.flatMap((edit) => {
    const before = str(edit.oldText ?? edit.old_string);
    const after = str(edit.newText ?? edit.new_string);
    if (before === null && after === null) return [];
    return [
      [before ? prefixLines(before, "-") : null, after ? prefixLines(after, "+") : null]
        .filter(Boolean)
        .join("\n"),
    ];
  });
  return hunks.length > 0 ? truncate(hunks.join("\n@@\n"), MAX_OUTPUT) : null;
}
