import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  type AuthMethod,
  type Client,
  ClientSideConnection,
  type InitializeResponse,
  type McpServer,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type ToolCallContent,
  type ToolCallUpdate,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type {
  ItemBody,
  ItemStatus,
  ModelOption,
  RuntimeMode,
  ToolKind,
} from "@agentplane/contracts";
import { SERVER_VERSION } from "../config.ts";
import { deferred, errorMessage, newId, truncate } from "../util.ts";
import { agentEnvironment } from "./detect.ts";
import { lastLoggedError } from "./setup.ts";
import type {
  AdapterEvent,
  OpenSessionOptions,
  ProviderAdapter,
  ProviderSession,
  RequestResponse,
} from "./types.ts";

export type AcpLaunch = { command: string; args: string[]; env?: Record<string, string> };

/**
 * One ACP agent. Everything about talking to it is the Agent Client Protocol
 * (https://agentclientprotocol.com); this only describes how to start it and
 * the few places agents differ.
 */
export type AcpAgentSpec = {
  id: string;
  label: string;
  /** How to start it. May install it first (registry agents), reporting progress via `notify`. */
  launch: (context: {
    mode: RuntimeMode;
    model: string | null;
    notify: (text: string) => void;
    /** False when only peeking (listing models): don't download anything big. */
    allowInstall?: boolean;
  }) => Promise<AcpLaunch>;
  /** The launch args already pick the model; otherwise use the model config option. */
  modelViaArgs?: boolean;
  /** What to tell the user when it isn't signed in. */
  signInHint: string;
  /** Serve fs/read_text_file and fs/write_text_file inside the thread's folder. */
  clientFs?: boolean;
  /** Sign in right after initialize with this auth method, if the agent offers it. */
  eagerAuthMethod?: string;
  /** The agent's own mode ids for our runtime modes, set after the session starts. */
  nativeModes?: Partial<Record<RuntimeMode, string>>;
  initializeMeta?: Record<string, unknown>;
  cancelMeta?: Record<string, unknown>;
  /** Some agents signal the end of a turn with an extension notification. */
  isTurnComplete?: (method: string, params: Record<string, unknown>) => boolean;
  /**
   * When no model was asked for: a model id to use instead of the agent's own
   * default (say, one that can't run here), or null to keep it.
   */
  preferredDefault?: (current: ModelOption | undefined, options: ModelOption[]) => string | null;
};

const MAX_OUTPUT = 20_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const AUTH_REQUIRED = -32000;

export function acpAdapter(spec: AcpAgentSpec): ProviderAdapter {
  return {
    provider: spec.id,
    listModels: () => listAcpModels(spec),
    async openSession(options) {
      // One notice per start that updates in place (download progress, unpacking).
      const noticeId = `notice:${newId()}`;
      const notify = (text: string) =>
        options.emit({ type: "item", id: noticeId, body: { kind: "notice", text }, final: true });
      const launch = await spec.launch({ mode: options.runtimeMode, model: options.model, notify });
      options.signal?.throwIfAborted();
      const session = new AcpSession(
        spec,
        launch,
        { ...(await agentEnvironment()), ...options.env },
        options,
      );
      options.signal?.addEventListener("abort", () => void session.close(), { once: true });
      try {
        await session.start(options);
      } catch (error) {
        await session.close();
        // Transport errors ("ACP connection closed") say nothing; explain them.
        throw new Error(session.explain(error));
      }
      return session;
    },
  };
}

type ToolCallBody = Extract<ItemBody, { kind: "tool_call" }>;
type TextSegment = {
  id: string;
  kind: "assistant_message" | "reasoning";
  text: string;
  messageId: string | null;
};

class AcpSession implements ProviderSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: ClientSideConnection;
  private readonly emit: (event: AdapterEvent) => void;
  private readonly cwd: string;
  /** Prefixes item ids: agents may reuse tool call ids across processes. */
  private readonly token = newId().slice(0, 8);
  private readonly toolCalls = new Map<string, ToolCallBody>();
  private readonly pending = new Map<string, (response: RequestResponse) => void>();
  private mode: RuntimeMode;
  private sessionId = "";
  private modes: SessionModeState | null = null;
  private configOptions: SessionConfigOption[] = [];
  /** Older agents (OpenCode, Grok) list models outside config options. */
  private legacyModels: LegacyModels | null = null;
  private authMethods: AuthMethod[] = [];
  private segment: TextSegment | null = null;
  private planItemId = `plan:${newId()}`;
  private replaying = false;
  private turnActive = false;
  /** Whether the agent produced anything this turn; some swallow errors and end silently. */
  private turnHadOutput = false;
  private costUsd: number | null = null;
  private stderrTail = "";
  private stdoutNoise = "";
  private exited = false;

  constructor(
    private readonly spec: AcpAgentSpec,
    launch: AcpLaunch,
    env: NodeJS.ProcessEnv,
    options: OpenSessionOptions,
  ) {
    this.emit = options.emit;
    this.mode = options.runtimeMode;
    this.cwd = options.cwd;
    this.child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...env, ...launch.env },
      stdio: "pipe",
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-4_000);
      this.watchForSignInLink(text);
    });
    this.child.on("exit", (code, signal) => this.onExit(code, signal));
    this.child.on("error", (error) => this.onExit(null, null, error.message));

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      jsonLinesOnly(this.child.stdout, (line) => {
        this.stdoutNoise = `${this.stdoutNoise}${line}\n`.slice(-4_000);
        this.watchForSignInLink(line);
      }),
    );
    const client: Client = {
      requestPermission: (params) => this.onPermissionRequest(params),
      sessionUpdate: async (params) => this.onSessionUpdate(params),
      extNotification: async (method, params) => {
        if (this.turnActive && spec.isTurnComplete?.(method, params)) {
          this.completeTurn({ status: "completed", usage: null, error: null });
        }
      },
      ...(spec.clientFs
        ? {
            readTextFile: (params: ReadTextFileRequest) => this.readTextFile(params),
            writeTextFile: (params: WriteTextFileRequest) => this.writeTextFile(params),
          }
        : {}),
    };
    this.connection = new ClientSideConnection(() => client, stream);
  }

  async start(options: OpenSessionOptions): Promise<void> {
    const init: InitializeResponse = await this.guard(
      this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // Agents use their own shell; file access is served only when the
        // agent needs it, and then only inside the thread's folder.
        clientCapabilities: {
          fs: {
            readTextFile: Boolean(this.spec.clientFs),
            writeTextFile: Boolean(this.spec.clientFs),
          },
          terminal: false,
          ...(this.spec.initializeMeta ? { _meta: this.spec.initializeMeta } : {}),
        },
        clientInfo: { name: "agentplane", title: "Agentplane", version: SERVER_VERSION },
      }),
    );
    this.authMethods = init.authMethods ?? [];
    const capabilities = init.agentCapabilities;
    // Remote MCP (Composio tools) only for agents that can reach HTTP servers.
    const mcpServers: McpServer[] = capabilities?.mcpCapabilities?.http
      ? (options.mcpServers ?? []).map((server) => ({
          type: "http" as const,
          name: server.name,
          url: server.url,
          headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
        }))
      : [];

    const eager = this.spec.eagerAuthMethod;
    if (eager && this.authMethods.some((method) => method.id === eager)) {
      await this.guard(this.connection.authenticate({ methodId: eager })).catch(
        (error: unknown) => {
          throw new Error(this.describeError(error));
        },
      );
    }

    let resumed = false;
    if (options.resumeId) {
      const sessionId = options.resumeId;
      try {
        if (capabilities?.sessionCapabilities?.resume) {
          const restored = await this.withAuth(() =>
            this.connection.resumeSession({ sessionId, cwd: options.cwd, mcpServers }),
          );
          this.sessionId = sessionId;
          this.modes = restored.modes ?? null;
          this.configOptions = restored.configOptions ?? [];
          this.legacyModels = legacyModelsOf(restored);
          resumed = true;
        } else if (capabilities?.loadSession) {
          // Loading replays the whole history as updates; we already have it.
          this.replaying = true;
          const loaded = await this.withAuth(() =>
            this.connection.loadSession({ sessionId, cwd: options.cwd, mcpServers }),
          );
          this.sessionId = sessionId;
          this.modes = loaded.modes ?? null;
          this.configOptions = loaded.configOptions ?? [];
          this.legacyModels = legacyModelsOf(loaded);
          resumed = true;
        }
      } catch (error) {
        this.emit({
          type: "item",
          id: `resume-failed:${this.token}`,
          body: {
            kind: "notice",
            text: `${this.spec.label}'s earlier session couldn't be restored (${errorMessage(error)}), so it starts fresh and gets this thread's history instead.`,
          },
          final: true,
        });
      } finally {
        this.replaying = false;
      }
    }

    if (!this.sessionId) {
      const created = await this.withAuth(() =>
        this.connection.newSession({ cwd: options.cwd, mcpServers }),
      ).catch((error: unknown) => {
        throw new Error(this.describeError(error));
      });
      this.sessionId = created.sessionId;
      this.modes = created.modes ?? null;
      this.configOptions = created.configOptions ?? [];
      this.legacyModels = legacyModelsOf(created);
    }
    await this.applyNativeMode(options.runtimeMode);
    const model = await this.applyModel(options.model);
    this.emit({
      type: "session.ready",
      providerSessionId: this.sessionId,
      model,
      ...(options.resumeId ? { resumed } : {}),
    });
  }

  async startTurn(text: string): Promise<void> {
    this.turnActive = true;
    this.turnHadOutput = false;
    this.planItemId = `plan:${newId()}`;
    // The prompt request stays open for the whole turn; it resolves with the
    // stop reason once the agent is done.
    this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }).then(
      (response) => {
        const usage = response.usage;
        this.completeTurn({
          status:
            response.stopReason === "cancelled"
              ? "interrupted"
              : response.stopReason === "refusal"
                ? "failed"
                : "completed",
          usage: usage
            ? {
                // Count cached tokens as input, like the native adapters do.
                inputTokens:
                  usage.inputTokens +
                  (usage.cachedReadTokens ?? 0) +
                  (usage.cachedWriteTokens ?? 0),
                outputTokens: usage.outputTokens,
                cachedInputTokens: usage.cachedReadTokens ?? 0,
              }
            : null,
          error: response.stopReason === "refusal" ? "The model refused to continue." : null,
        });
      },
      (error: unknown) => {
        this.completeTurn({ status: "failed", usage: null, error: this.describeError(error) });
      },
    );
  }

  async interrupt(): Promise<void> {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    if (!this.turnActive) return;
    await this.connection.cancel({
      sessionId: this.sessionId,
      ...(this.spec.cancelMeta ? { _meta: this.spec.cancelMeta } : {}),
    });
  }

  respondToRequest(itemId: string, response: RequestResponse): void {
    const respond = this.pending.get(itemId);
    if (!respond) throw new Error("That request is no longer pending.");
    this.pending.delete(itemId);
    respond(response);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    // Our permission policy reads this at the next request; the agent's own
    // mode (if it has one) is switched too.
    this.mode = mode;
    await this.applyNativeMode(mode);
  }

  async close(): Promise<void> {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    if (!this.exited) this.child.kill("SIGTERM");
  }

  // ─── Session setup ─────────────────────────────────────────────────────────

  /**
   * Retry once after signing in when a session call says auth is required
   * and the agent offers a method it can run by itself.
   */
  private async withAuth<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await this.guard(call());
    } catch (error) {
      if ((error as { code?: number }).code !== AUTH_REQUIRED) throw error;
      // Only methods the agent runs by itself; terminal / env-var logins need the user.
      const method = this.authMethods.find((candidate) => {
        const type = (candidate as { type?: string }).type;
        return type === undefined || type === "agent";
      });
      if (!method) throw error;
      await this.guard(this.connection.authenticate({ methodId: method.id }));
      return this.guard(call());
    }
  }

  private async applyNativeMode(mode: RuntimeMode): Promise<void> {
    const target = this.spec.nativeModes?.[mode];
    if (!target) return;
    try {
      const option = this.configOptions.find(
        (candidate) => candidate.category === "mode" && candidate.type === "select",
      );
      if (option) {
        await this.connection.setSessionConfigOption({
          sessionId: this.sessionId,
          configId: option.id,
          value: target,
        });
      } else if (this.modes?.availableModes.some((candidate) => candidate.id === target)) {
        await this.connection.setSessionMode({ sessionId: this.sessionId, modeId: target });
      }
    } catch {
      // Our own permission policy still applies; the native mode is a bonus.
    }
  }

  /**
   * Pick the requested model the way this agent supports (config option, or
   * the older session/set_model), and report what's active.
   */
  private async applyModel(asked: string | null): Promise<string | null> {
    const available = modelChoices(this.configOptions, this.legacyModels);
    if (!available) return asked;
    const current = available.options.find((option) => option.isDefault);
    const requested =
      asked ??
      (this.spec.modelViaArgs ? null : this.spec.preferredDefault?.(current, available.options)) ??
      null;
    if (!requested || this.spec.modelViaArgs) return requested ?? current?.name ?? null;
    const match = matchModel(available.options, requested);
    if (!match) return requested;
    try {
      if (available.configId) {
        await this.connection.setSessionConfigOption({
          sessionId: this.sessionId,
          configId: available.configId,
          value: match.id,
        });
      } else {
        await this.connection.request("session/set_model", {
          sessionId: this.sessionId,
          modelId: match.id,
        });
      }
      return match.name;
    } catch {
      return current?.name ?? requested;
    }
  }

  // ─── Agent → client ────────────────────────────────────────────────────────

  private async onPermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const call = this.mergeToolCall(params.toolCall);
    const kind = params.toolCall.kind ?? null;
    const auto =
      kind === "read" ||
      kind === "search" ||
      kind === "think" ||
      this.mode === "full-access" ||
      (this.mode === "auto-edit" && (kind === "edit" || kind === "delete" || kind === "move"));
    if (auto) return selectOption(params.options, "approve");

    const itemId = `approval:${this.token}:${params.toolCall.toolCallId}:${newId().slice(0, 4)}`;
    const request: ItemBody = {
      kind: "approval",
      requestKind:
        kind === "execute" ? "command" : call.toolKind === "file_change" ? "file_change" : "tool",
      tool: params.toolCall.name ?? call.tool,
      title: params.toolCall.title ?? call.title,
      detail: call.detail,
      diff: call.diff,
      reason: null,
      status: "pending",
    };
    this.emit({ type: "item", id: itemId, body: request, final: true });
    const answer = deferred<RequestResponse>();
    this.pending.set(itemId, answer.resolve);
    const response = await answer.promise;
    const status =
      response.kind !== "approval"
        ? "cancelled"
        : response.decision === "deny"
          ? "denied"
          : "approved";
    this.emit({ type: "item", id: itemId, body: { ...request, status }, final: true });
    if (response.kind !== "approval") return { outcome: { outcome: "cancelled" } };
    return selectOption(params.options, response.decision);
  }

  private onSessionUpdate(notification: SessionNotification): void {
    if (this.replaying || notification.sessionId !== this.sessionId) return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        if (update.content.type !== "text") return;
        this.turnHadOutput = true;
        this.appendText(
          update.sessionUpdate === "agent_message_chunk" ? "assistant_message" : "reasoning",
          update.content.text,
          update.messageId ?? null,
        );
        return;
      case "tool_call":
      case "tool_call_update": {
        this.turnHadOutput = true;
        this.closeSegment();
        const body = this.mergeToolCall(update);
        const final = body.status !== "running";
        this.emit({ type: "item", id: this.toolItemId(update.toolCallId), body, final });
        if (final) this.toolCalls.delete(update.toolCallId);
        return;
      }
      case "plan":
        this.closeSegment();
        this.emit({
          type: "item",
          id: this.planItemId,
          body: {
            kind: "plan",
            steps: update.entries.map((entry) => ({ text: entry.content, status: entry.status })),
          },
          final: true,
        });
        return;
      case "usage_update":
        if (update.cost && update.cost.currency.toUpperCase() === "USD") {
          this.costUsd = update.cost.amount;
        }
        return;
      case "config_option_update":
        this.configOptions = update.configOptions;
        return;
      default:
        return;
    }
  }

  /** Paths must resolve inside the thread's folder, symlinks included. */
  private async confine(path: string): Promise<string> {
    const target = isAbsolute(path) ? path : resolve(this.cwd, path);
    const root = await realpath(this.cwd);
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      // A new file: check its parent instead.
      real = resolve(
        await realpath(dirname(target)).catch(() => dirname(target)),
        target.split(sep).pop() ?? "",
      );
    }
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new Error(`${path} is outside the thread's folder.`);
    }
    return real;
  }

  private async readTextFile(params: ReadTextFileRequest) {
    const path = await this.confine(params.path);
    const content = await readFile(path, "utf8");
    if (content.length > MAX_FILE_BYTES) throw new Error(`${params.path} is too large to read.`);
    if (params.line == null && params.limit == null) return { content };
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit == null ? lines.length : start + params.limit;
    return { content: lines.slice(start, end).join("\n") };
  }

  private async writeTextFile(params: WriteTextFileRequest) {
    const path = await this.confine(params.path);
    if (params.content.length > MAX_FILE_BYTES) throw new Error(`${params.path} is too large.`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
    return {};
  }

  // ─── Mapping ───────────────────────────────────────────────────────────────

  private toolItemId(toolCallId: string): string {
    return `${this.token}:${toolCallId}`;
  }

  /** Fold a tool call or update into the call's current state. */
  private mergeToolCall(update: ToolCallUpdate): ToolCallBody {
    const previous = this.toolCalls.get(update.toolCallId);
    const kind = update.kind ?? null;
    const content = update.content ?? null;
    const raw = update.rawInput as Record<string, unknown> | undefined;
    const body: ToolCallBody = {
      kind: "tool_call",
      tool: update.name ?? previous?.tool ?? kind ?? "tool",
      toolKind: kind ? TOOL_KINDS[kind] : (previous?.toolKind ?? "other"),
      // Some agents (OpenCode, for MCP tools) send an empty title: use the tool's name.
      title: update.title || previous?.title || update.name || kind || "Tool call",
      detail: commandOf(raw) ?? update.locations?.[0]?.path ?? previous?.detail ?? null,
      output: content ? (textOf(content) ?? previous?.output ?? null) : (previous?.output ?? null),
      diff: content ? (diffOf(content) ?? previous?.diff ?? null) : (previous?.diff ?? null),
      status: update.status ? STATUS[update.status] : (previous?.status ?? "running"),
    };
    if (body.output === null && update.rawOutput !== undefined && body.status !== "running") {
      body.output = stringify(update.rawOutput);
    }
    this.toolCalls.set(update.toolCallId, body);
    return body;
  }

  private appendText(kind: TextSegment["kind"], text: string, messageId: string | null): void {
    if (
      !this.segment ||
      this.segment.kind !== kind ||
      (messageId !== null &&
        this.segment.messageId !== null &&
        this.segment.messageId !== messageId)
    ) {
      this.closeSegment();
      this.segment = { id: `${kind}:${newId()}`, kind, text: "", messageId };
    }
    this.segment.text += text;
    if (!this.segment.text.trim()) return;
    this.emit({
      type: "item",
      id: this.segment.id,
      body: { kind, text: this.segment.text, streaming: true },
      final: false,
    });
  }

  private closeSegment(): void {
    const segment = this.segment;
    this.segment = null;
    if (!segment?.text.trim()) return;
    this.emit({
      type: "item",
      id: segment.id,
      body: { kind: segment.kind, text: segment.text, streaming: false },
      final: true,
    });
  }

  private completeTurn(result: {
    status: "completed" | "interrupted" | "failed";
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
    error: string | null;
  }): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.closeSegment();
    for (const [id, call] of this.toolCalls) {
      if (call.status === "running") {
        this.emit({
          type: "item",
          id: this.toolItemId(id),
          body: { ...call, status: result.status === "completed" ? "completed" : "failed" },
          final: true,
        });
      }
    }
    this.toolCalls.clear();
    const silent = result.status === "completed" && !this.turnHadOutput;
    this.emit({
      type: "turn.completed",
      ...(silent
        ? {
            status: "failed",
            usage: result.usage,
            error: this.silentTurnReason(),
          }
        : result),
      costUsd: this.costUsd,
    });
  }

  /** Why a turn ended with no output: the agent's own logged error if it left one. */
  private silentTurnReason(): string {
    const logged = lastLoggedError(this.stderrTail);
    return logged
      ? `${this.spec.label} couldn't run this: ${logged}. ${this.spec.signInHint}`
      : `${this.spec.label} ended the turn without responding. It may not be signed in or have a model configured. ${this.spec.signInHint}`;
  }

  private watchForSignInLink(text: string): void {
    const url = signInLink(text);
    if (!url) return;
    this.emit({
      type: "item",
      id: `sign-in:${this.token}`,
      body: {
        kind: "notice",
        text: `${this.spec.label} needs you to sign in. [Open the sign-in page](${url}), finish signing in, and this thread continues.`,
      },
      final: true,
    });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, failure?: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    // 143 is 128 + SIGTERM: some CLIs report being stopped as an exit code.
    const clean = code === 0 || code === 143 || signal === "SIGTERM";
    const detail =
      lastLoggedError(this.stderrTail) ??
      (this.stderrTail.trim() || this.stdoutNoise.trim()).slice(-1_500);
    const error = clean
      ? null
      : (failure ?? (detail || `${this.spec.label} exited with ${code ?? signal}`));
    if (this.turnActive) {
      this.completeTurn({
        status: "failed",
        usage: null,
        error: error ?? `${this.spec.label} exited mid-turn.`,
      });
    }
    this.emit({ type: "session.exited", error });
  }

  /** Reject promptly if the agent dies before answering. */
  private guard<T>(request: Promise<T>): Promise<T> {
    return Promise.race([
      request,
      new Promise<T>((_, reject) => {
        const fail = () =>
          reject(
            new Error(
              (this.stderrTail.trim() || this.stdoutNoise.trim()).slice(-1_500) ||
                `${this.spec.label} exited before it finished starting.`,
            ),
          );
        if (this.exited) fail();
        else this.child.once("exit", fail);
      }),
    ]);
  }

  /** Why starting or talking to the agent failed, in words a person can act on. */
  explain(error: unknown): string {
    return this.describeError(error);
  }

  private describeError(error: unknown): string {
    const code = (error as { code?: number }).code;
    const message = errorMessage(error);
    if (code === AUTH_REQUIRED) {
      return `${this.spec.label} isn't signed in. ${this.spec.signInHint} (${message})`;
    }
    return friendlyAcpError(this.spec, error, this.stderrTail, this.stdoutNoise);
  }
}

/** Turn transport-level failures into something a person can act on. */
function friendlyAcpError(spec: AcpAgentSpec, error: unknown, stderr: string, stdout = ""): string {
  const message = errorMessage(error);
  if (message.includes("closed the connection without answering")) return message;
  if (/connection closed|exited/i.test(message)) {
    // What it said on the way out: its last error, or (an old build that
    // doesn't speak ACP prints its usage) the first thing it printed.
    const readable = (text: string | undefined) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes.
      const plain = text?.replace(/\u001b\[[0-9;?]*[A-Za-z]|[\u0000-\u001f]/g, "").trim() ?? "";
      return /[a-z]{3}/i.test(plain) ? plain.slice(0, 160) : "";
    };
    const detail =
      lastLoggedError(stderr) ||
      readable(stderr.trim().split("\n").pop()) ||
      readable(stdout.trim().split("\n")[0]);
    return `${spec.label} closed the connection without answering${detail ? ` (${detail})` : ""}. ${spec.signInHint}`;
  }
  return message;
}

type LegacyModels = {
  currentModelId?: string;
  availableModels?: Array<{ modelId: string; name?: string; description?: string | null }>;
};

function legacyModelsOf(response: unknown): LegacyModels | null {
  const models = (response as { models?: LegacyModels } | null)?.models;
  return models?.availableModels?.length ? models : null;
}

/** An agent's models, from its model config option or its older model list. */
export function modelChoices(
  configOptions: SessionConfigOption[],
  legacy: LegacyModels | null,
): { configId: string | null; options: ModelOption[] } | null {
  const option = configOptions.find(
    (candidate) => candidate.category === "model" && candidate.type === "select",
  );
  if (option?.type === "select") {
    const choices = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
    return {
      configId: option.id,
      options: choices.map((choice) => ({
        id: choice.value,
        name: choice.name,
        description: choice.description ?? null,
        isDefault: choice.value === option.currentValue,
        aliases: [],
      })),
    };
  }
  if (legacy?.availableModels?.length) {
    return {
      configId: null,
      options: legacy.availableModels.map((model) => ({
        id: model.modelId,
        name: model.name ?? model.modelId,
        description: model.description ?? null,
        isDefault: model.modelId === legacy.currentModelId,
        aliases: [],
      })),
    };
  }
  return null;
}

/** Exact id first, then a name or id that contains what was asked for. */
export function matchModel(options: ModelOption[], requested: string): ModelOption | undefined {
  const wanted = requested.toLowerCase();
  return (
    options.find((option) => option.id.toLowerCase() === wanted) ??
    options.find((option) => option.aliases.some((alias) => alias.toLowerCase() === wanted)) ??
    options.find(
      (option) =>
        option.id.toLowerCase().includes(wanted) || option.name.toLowerCase().includes(wanted),
    )
  );
}

/**
 * Start the agent just long enough to open a throwaway session and read the
 * models it advertises. Never signs in or downloads anything on its own.
 */
async function listAcpModels(spec: AcpAgentSpec): Promise<ModelOption[]> {
  const launch = await spec.launch({
    mode: "supervised",
    model: null,
    notify: () => undefined,
    allowInstall: false,
  });
  const child = spawn(launch.command, launch.args, {
    cwd: tmpdir(),
    env: { ...(await agentEnvironment()), ...launch.env },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", () =>
      reject(new Error(stderr.trim().split("\n").pop() || `${spec.label} exited`)),
    );
    child.once("error", (error) => reject(error));
  });
  const connection = new ClientSideConnection(
    () => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async () => undefined,
    }),
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      jsonLinesOnly(child.stdout, () => undefined),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), 25_000);
  });
  // Whichever of these loses the race rejects later; that must not crash the server.
  exited.catch(() => undefined);
  timeout.catch(() => undefined);
  try {
    return await Promise.race([
      (async () => {
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "agentplane", title: "Agentplane", version: SERVER_VERSION },
          ...(spec.initializeMeta ? { _meta: spec.initializeMeta } : {}),
        });
        const created = await connection
          .newSession({ cwd: tmpdir(), mcpServers: [] })
          .catch((error: unknown) => {
            if ((error as { code?: number }).code === AUTH_REQUIRED) {
              throw new Error(`Sign in to ${spec.label} to see its models. ${spec.signInHint}`);
            }
            throw error;
          });
        const options =
          modelChoices(created.configOptions ?? [], legacyModelsOf(created))?.options ?? [];
        // Show the default this agent will really get here.
        const preferred = spec.preferredDefault?.(
          options.find((option) => option.isDefault),
          options,
        );
        return preferred
          ? options.map((option) => ({ ...option, isDefault: option.id === preferred }))
          : options;
      })(),
      exited,
      timeout,
    ]);
  } catch (error) {
    throw new Error(friendlyAcpError(spec, error, stderr));
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
  }
}

/**
 * Some agents print plain text (sign-in links, banners) on stdout next to the
 * protocol. Pass only JSON lines to the ACP stream and report the rest.
 */
function jsonLinesOnly(
  input: Readable,
  onNoise: (line: string) => void,
): ReadableStream<Uint8Array> {
  const decoder = new StringDecoder("utf8");
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("{")) controller.enqueue(encoder.encode(`${line}\n`));
          else if (line) onNoise(line);
          newline = buffer.indexOf("\n");
        }
      });
      input.on("end", () => controller.close());
      input.on("error", (error) => controller.error(error));
    },
  });
}

const TOOL_KINDS: Record<NonNullable<ToolCallUpdate["kind"]>, ToolKind> = {
  read: "read",
  edit: "file_change",
  delete: "file_change",
  move: "file_change",
  search: "search",
  execute: "command",
  think: "other",
  fetch: "web",
  switch_mode: "other",
  other: "other",
};

const STATUS: Record<NonNullable<ToolCallUpdate["status"]>, ItemStatus> = {
  pending: "running",
  in_progress: "running",
  completed: "completed",
  failed: "failed",
};

/** Pick the agent's option that matches a decision, falling back sensibly. */
export function selectOption(
  options: PermissionOption[],
  decision: "approve" | "approve-session" | "deny",
): RequestPermissionResponse {
  const preference: Array<PermissionOption["kind"]> =
    decision === "approve"
      ? ["allow_once", "allow_always"]
      : decision === "approve-session"
        ? ["allow_always", "allow_once"]
        : ["reject_once", "reject_always"];
  for (const kind of preference) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function commandOf(raw: Record<string, unknown> | undefined): string | null {
  if (!raw) return null;
  const command = raw.command ?? raw.cmd;
  if (typeof command === "string" && command) return command;
  if (Array.isArray(command)) return command.join(" ");
  return null;
}

function textOf(content: ToolCallContent[]): string | null {
  const parts = content.flatMap((entry) =>
    entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : [],
  );
  return parts.length > 0 ? truncate(parts.join("\n"), MAX_OUTPUT) : null;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function diffOf(content: ToolCallContent[]): string | null {
  const diffs = content.flatMap((entry) => (entry.type === "diff" ? [entry] : []));
  if (diffs.length === 0) return null;
  return truncate(
    diffs
      .map((diff) =>
        [
          `--- ${diff.path}`,
          diff.oldText ? prefixLines(diff.oldText, "-") : null,
          prefixLines(diff.newText, "+"),
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n"),
    MAX_OUTPUT,
  );
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(value, MAX_OUTPUT);
  const output = (value as { output?: unknown }).output;
  if (typeof output === "string") return truncate(output, MAX_OUTPUT);
  return truncate(JSON.stringify(value, null, 2), MAX_OUTPUT);
}

/**
 * A sign-in URL an agent printed ("Log in at https://…"). The link must sit
 * right after the sign-in words with no JSON in between, so URLs inside logged
 * payloads (schemas, API endpoints) don't pass for one.
 */
export function signInLink(text: string): string | null {
  const match =
    /\b(?:authenticate|sign in|log in|login)\b[^\n{}"]{0,80}?(https:\/\/[^\s"'<>(){}[\]]+)/i.exec(
      text,
    );
  return match?.[1]?.replace(/[.,;:]+$/, "") ?? null;
}
