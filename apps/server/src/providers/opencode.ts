import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import type {
  ItemBody,
  McpServerConfig,
  ModelOption,
  QuestionSpec,
  RuntimeMode,
  ToolKind,
  Usage,
} from "@agentplane/contracts";
import { deferred, newId, truncate, withTimeout } from "../util.ts";
import { agentEnvironment } from "./detect.ts";
import type {
  AdapterEvent,
  OpenSessionOptions,
  ProviderAdapter,
  ProviderSession,
  RequestResponse,
} from "./types.ts";

/**
 * OpenCode over its own HTTP server (`opencode serve`): REST calls plus one
 * server-sent event stream. Unlike its ACP mode this reports real usage and
 * cost, takes messages mid-turn, and shows the diff in edit approvals.
 *
 * Each session runs its own server on a random loopback port with a random
 * password, so nothing else on the machine can drive it.
 */

/** How to start OpenCode: its CLI on PATH or the ACP registry's build of it. */
export type OpencodeLaunch = { command: string; env?: Record<string, string> };

export type OpencodeOptions = {
  launch: (context: {
    notify: (text: string) => void;
    allowInstall?: boolean;
  }) => Promise<OpencodeLaunch>;
  /** Extra environment, e.g. the user's OpenRouter key. */
  env: () => Promise<Record<string, string>>;
  /** A model to use instead of OpenCode's own default, or null to keep it. */
  preferredDefault?: (current: ModelOption | undefined, options: ModelOption[]) => string | null;
};

const MAX_OUTPUT = 20_000;

/** Ask before every edit, command, fetch and step outside the folder; the thread's mode answers. */
const PERMISSIONS = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  external_directory: "ask",
  doom_loop: "ask",
};

const TOOL_KINDS: Record<string, ToolKind> = {
  bash: "command",
  edit: "file_change",
  write: "file_change",
  patch: "file_change",
  multiedit: "file_change",
  read: "read",
  grep: "search",
  glob: "search",
  list: "search",
  codesearch: "search",
  webfetch: "web",
  websearch: "web",
  task: "subagent",
};

type ToolCallBody = Extract<ItemBody, { kind: "tool_call" }>;
type Json = Record<string, unknown>;
type MessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  error?: { name?: string; data?: { message?: string } };
};
type Part = Json & { id: string; sessionID: string; messageID: string; type: string };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No port")),
      );
    });
  });
}

/** One `opencode serve` process and an authenticated client for it. */
class OpencodeServer {
  readonly child: ChildProcess;
  private readonly password = randomBytes(24).toString("base64url");
  private port = 0;
  stderrTail = "";

  private constructor(
    launch: OpencodeLaunch,
    port: number,
    cwd: string,
    env: NodeJS.ProcessEnv,
    config: Json,
  ) {
    this.port = port;
    this.child = spawn(
      launch.command,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd,
        env: {
          ...env,
          ...launch.env,
          OPENCODE_SERVER_PASSWORD: this.password,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4_000);
    });
  }

  static async start(launch: OpencodeLaunch, cwd: string, env: NodeJS.ProcessEnv, config: Json) {
    const server = new OpencodeServer(launch, await freePort(), cwd, env, config);
    const ready = deferred<void>();
    let stdout = "";
    server.child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("listening on")) ready.resolve();
    });
    server.child.once("exit", (code) =>
      ready.reject(
        new Error(server.stderrTail.trim().slice(-1_500) || `opencode serve exited with ${code}`),
      ),
    );
    server.child.once("error", (error) => ready.reject(error));
    try {
      await withTimeout(ready.promise, 30_000);
    } catch (error) {
      server.child.kill("SIGTERM");
      throw error;
    }
    return server;
  }

  get headers(): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
      "content-type": "application/json",
    };
  }

  url(path: string, directory: string): string {
    const url = new URL(path, `http://127.0.0.1:${this.port}`);
    url.searchParams.set("directory", directory);
    return url.toString();
  }

  async call<T = unknown>(
    method: string,
    path: string,
    directory: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(this.url(path, directory), {
      method,
      headers: this.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { data?: { message?: string }; message?: string };
        message = parsed.data?.message ?? parsed.message ?? text;
      } catch {
        // Plain text error.
      }
      throw new HttpError(response.status, message || `OpenCode answered ${response.status}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  stop(): void {
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ProvidersResponse = {
  providers: Array<{
    id: string;
    name?: string;
    models: Record<string, { id?: string; name?: string }>;
  }>;
};

function modelOptions(providers: ProvidersResponse, current: string | null): ModelOption[] {
  return providers.providers.flatMap((provider) =>
    Object.entries(provider.models).map(([key, model]) => {
      const id = `${provider.id}/${model.id ?? key}`;
      return {
        id,
        name: model.name ?? key,
        description: provider.name ?? provider.id,
        isDefault: id === current,
        aliases: [model.id ?? key],
      };
    }),
  );
}

function splitModel(model: string): { providerID: string; modelID: string } | null {
  const slash = model.indexOf("/");
  return slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : null;
}

export function opencodeAdapter(spec: OpencodeOptions): ProviderAdapter {
  const environment = async (extra?: Record<string, string>) => ({
    ...(await agentEnvironment()),
    ...(await spec.env()),
    ...extra,
  });

  /** Models from a short-lived server, with the default this app will really use marked. */
  const listModels = async (): Promise<ModelOption[]> => {
    const launch = await spec.launch({ notify: () => undefined, allowInstall: false });
    const server = await OpencodeServer.start(launch, tmpdir(), await environment(), {
      permission: PERMISSIONS,
    });
    try {
      const dir = tmpdir();
      const [providers, config] = await Promise.all([
        server.call<ProvidersResponse>("GET", "/config/providers", dir),
        server.call<{ model?: string }>("GET", "/config", dir),
      ]);
      const options = modelOptions(providers, config.model ?? null);
      const preferred = spec.preferredDefault?.(
        options.find((option) => option.isDefault),
        options,
      );
      return preferred
        ? options.map((option) => ({ ...option, isDefault: option.id === preferred }))
        : options;
    } finally {
      server.stop();
    }
  };

  return {
    provider: "opencode",
    canSteer: true,
    listModels,
    async openSession(options) {
      const noticeId = `notice:${newId()}`;
      const notify = (text: string) =>
        options.emit({ type: "item", id: noticeId, body: { kind: "notice", text }, final: true });
      const launch = await spec.launch({ notify });
      options.signal?.throwIfAborted();
      const config: Json = {
        permission: PERMISSIONS,
        ...(options.mcpServers?.length ? { mcp: mcpConfig(options.mcpServers) } : {}),
      };
      const server = await OpencodeServer.start(
        launch,
        options.cwd,
        await environment(options.env),
        config,
      );
      const session = new OpencodeSession(server, options, spec);
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

function mcpConfig(servers: McpServerConfig[]): Json {
  return Object.fromEntries(
    servers.map((server) => [
      server.name,
      { type: "remote", url: server.url, headers: server.headers, enabled: true },
    ]),
  );
}

class OpencodeSession implements ProviderSession {
  private readonly emit: (event: AdapterEvent) => void;
  private readonly cwd: string;
  private readonly token = newId().slice(0, 8);
  private readonly events = new AbortController();
  private sessionId = "";
  private model: { providerID: string; modelID: string } | null = null;
  private mode: RuntimeMode;

  private readonly roles = new Map<string, "user" | "assistant">();
  /** Parts that arrived before we knew whose message they belong to. */
  private readonly orphanParts = new Map<string, Part[]>();
  private readonly texts = new Map<
    string,
    { kind: "assistant_message" | "reasoning"; text: string }
  >();
  private readonly toolCalls = new Map<string, ToolCallBody>();
  private readonly pending = new Map<string, (response: RequestResponse) => void>();
  /** Every assistant message's cost, for the session's running total. */
  private readonly costs = new Map<string, number>();
  /** Assistant messages of the running turn, for its usage. */
  private readonly turnMessages = new Map<string, MessageInfo>();

  private turnActive = false;
  private interrupting = false;
  private sawBusy = false;
  private turnHadOutput = false;
  private turnError: string | null = null;
  private lastEventAt = 0;
  private settling = false;
  private closed = false;

  constructor(
    private readonly server: OpencodeServer,
    private readonly options: OpenSessionOptions,
    private readonly spec: OpencodeOptions,
  ) {
    this.emit = options.emit;
    this.cwd = options.cwd;
    this.mode = options.runtimeMode;
    server.child.once("exit", (code, signal) => this.onExit(code, signal));
  }

  async start(): Promise<void> {
    await this.listen();
    let resumed: boolean | undefined;
    if (this.options.resumeId) {
      const existing = await this.server
        .call<{ id: string }>(
          "GET",
          `/session/${encodeURIComponent(this.options.resumeId)}`,
          this.cwd,
        )
        .catch(() => null);
      resumed = existing !== null;
      if (existing) this.sessionId = existing.id;
    }
    if (!this.sessionId) {
      const created = await this.server.call<{ id: string }>("POST", "/session", this.cwd, {});
      this.sessionId = created.id;
    }
    this.model = await this.pickModel();
    this.emit({
      type: "session.ready",
      providerSessionId: this.sessionId,
      model: this.model ? `${this.model.providerID}/${this.model.modelID}` : null,
      ...(resumed === undefined ? {} : { resumed }),
    });
  }

  /** The thread's model, else OpenCode's default unless the catalog prefers another. */
  private async pickModel() {
    if (this.options.model) return splitModel(this.options.model);
    const config = await this.server
      .call<{ model?: string }>("GET", "/config", this.cwd)
      .catch(() => ({}) as { model?: string });
    const current = config.model ?? null;
    if (this.spec.preferredDefault) {
      const providers = await this.server
        .call<ProvidersResponse>("GET", "/config/providers", this.cwd)
        .catch(() => null);
      if (providers) {
        const options = modelOptions(providers, current);
        const preferred = this.spec.preferredDefault(
          options.find((option) => option.isDefault),
          options,
        );
        if (preferred) return splitModel(preferred);
      }
    }
    return current ? splitModel(current) : null;
  }

  async startTurn(text: string): Promise<void> {
    this.turnActive = true;
    this.interrupting = false;
    this.sawBusy = false;
    this.turnHadOutput = false;
    this.turnError = null;
    this.turnMessages.clear();
    await this.prompt(text);
  }

  /** OpenCode folds a message sent mid-run into its next step. */
  async steer(text: string): Promise<boolean> {
    if (!this.turnActive || this.interrupting) return false;
    return this.prompt(text).then(
      () => true,
      () => false,
    );
  }

  private prompt(text: string): Promise<unknown> {
    return this.server.call("POST", `/session/${this.sessionId}/prompt_async`, this.cwd, {
      parts: [{ type: "text", text }],
      ...(this.model ? { model: this.model } : {}),
    });
  }

  async interrupt(): Promise<void> {
    this.cancelPending();
    if (!this.turnActive) return;
    this.interrupting = true;
    await this.server
      .call("POST", `/session/${this.sessionId}/abort`, this.cwd)
      .catch(() => undefined);
  }

  respondToRequest(itemId: string, response: RequestResponse): void {
    const respond = this.pending.get(itemId);
    if (!respond) throw new Error("That request is no longer pending.");
    this.pending.delete(itemId);
    respond(response);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    // Every permission is "ask"; the mode decides which ones reach the user.
    this.mode = mode;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    if (this.turnActive && this.sessionId) {
      await this.server
        .call("POST", `/session/${this.sessionId}/abort`, this.cwd)
        .catch(() => undefined);
    }
    this.events.abort();
    this.server.stop();
  }

  private cancelPending(): void {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
  }

  // ─── OpenCode → us ─────────────────────────────────────────────────────────

  /** Read the event stream until the session closes. */
  private async listen(): Promise<void> {
    const response = await fetch(this.server.url("/event", this.cwd), {
      headers: this.server.headers,
      signal: this.events.signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`OpenCode's event stream answered ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) {
              try {
                this.onEvent(JSON.parse(data) as { type: string; properties?: Json });
              } catch (error) {
                console.error(
                  "[opencode] bad event:",
                  error instanceof Error ? error.message : error,
                );
              }
            }
            end = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Aborted on close, or the server went away (onExit reports that).
      }
    })();
  }

  private onEvent(event: { type: string; properties?: Json }): void {
    const props = event.properties ?? {};
    const sessionID =
      (props.sessionID as string | undefined) ??
      ((props.info as Json | undefined)?.sessionID as string | undefined) ??
      ((props.part as Json | undefined)?.sessionID as string | undefined);
    if (sessionID !== this.sessionId) return;
    this.lastEventAt = Date.now();
    switch (event.type) {
      case "message.updated":
        this.onMessage(props.info as MessageInfo);
        return;
      case "message.part.updated":
        this.onPart(props.part as Part);
        return;
      case "message.part.delta":
        this.onDelta(props);
        return;
      case "permission.asked":
        this.onPermission(props);
        return;
      case "question.asked":
        this.onQuestion(props);
        return;
      case "session.status": {
        const type = (props.status as { type?: string } | undefined)?.type;
        if (type === "busy" || type === "retry") this.sawBusy = true;
        if (type === "idle") this.settle();
        return;
      }
      case "session.idle":
        this.settle();
        return;
      case "session.error": {
        const error = props.error as MessageInfo["error"] | undefined;
        if (!this.turnActive || error?.name === "MessageAbortedError") return;
        this.turnError = error?.data?.message ?? error?.name ?? "OpenCode hit an error.";
        return;
      }
      default:
        return;
    }
  }

  private onMessage(info: MessageInfo): void {
    if (!info?.id) return;
    this.roles.set(info.id, info.role);
    if (info.role === "assistant") {
      if (typeof info.cost === "number") this.costs.set(info.id, info.cost);
      if (this.turnActive) {
        this.sawBusy = true;
        this.turnMessages.set(info.id, info);
        if (info.error && info.error.name !== "MessageAbortedError") {
          this.turnError = info.error.data?.message ?? info.error.name ?? "OpenCode hit an error.";
        }
      }
    }
    const waiting = this.orphanParts.get(info.id);
    if (waiting) {
      this.orphanParts.delete(info.id);
      for (const part of waiting) this.onPart(part);
    }
  }

  private onPart(part: Part): void {
    if (!part?.id) return;
    const role = this.roles.get(part.messageID);
    if (!role) {
      const list = this.orphanParts.get(part.messageID) ?? [];
      list.push(part);
      this.orphanParts.set(part.messageID, list);
      return;
    }
    // The user's own prompt comes back as parts too.
    if (role !== "assistant") return;
    if (part.type === "text" || part.type === "reasoning") {
      const kind = part.type === "text" ? "assistant_message" : "reasoning";
      const text = String(part.text ?? "");
      this.texts.set(part.id, { kind, text });
      const final = Boolean((part.time as { end?: number } | undefined)?.end);
      this.emitText(part.id, final);
      return;
    }
    if (part.type === "tool") this.onTool(part);
  }

  private onDelta(props: Json): void {
    const partID = String(props.partID ?? "");
    if (props.field !== "text" || !partID) return;
    const role = this.roles.get(String(props.messageID ?? ""));
    if (role && role !== "assistant") return;
    const segment = this.texts.get(partID) ?? { kind: "assistant_message" as const, text: "" };
    segment.text += String(props.delta ?? "");
    this.texts.set(partID, segment);
    this.emitText(partID, false);
  }

  private emitText(partId: string, final: boolean): void {
    const segment = this.texts.get(partId);
    if (!segment?.text.trim()) return;
    this.turnHadOutput = true;
    if (final) this.texts.delete(partId);
    this.emit({
      type: "item",
      id: `${this.token}:${partId}`,
      body: { kind: segment.kind, text: segment.text, streaming: !final },
      final,
    });
  }

  private onTool(part: Part): void {
    const callId = String(part.callID ?? part.id);
    const tool = String(part.tool ?? "tool");
    const state = (part.state ?? {}) as {
      status?: string;
      input?: Json;
      output?: string;
      title?: string;
      error?: string;
      metadata?: Json;
    };
    const input = state.input ?? {};
    const previous = this.toolCalls.get(callId);
    const running = state.status === "pending" || state.status === "running";
    const output =
      state.status === "error"
        ? (state.error ?? null)
        : (state.output ??
          (typeof state.metadata?.output === "string" ? state.metadata.output : null));
    const diff = typeof state.metadata?.diff === "string" ? state.metadata.diff : null;
    const body: ToolCallBody = {
      kind: "tool_call",
      tool,
      toolKind: TOOL_KINDS[tool] ?? (tool.includes("_") ? "mcp" : "other"),
      title: tool.charAt(0).toUpperCase() + tool.slice(1),
      detail: toolDetail(input, this.cwd) ?? state.title ?? previous?.detail ?? null,
      output: output ? truncate(output, MAX_OUTPUT) : (previous?.output ?? null),
      diff: diff ? truncate(diff, MAX_OUTPUT) : (previous?.diff ?? null),
      status: running ? "running" : state.status === "error" ? "failed" : "completed",
    };
    this.turnHadOutput = true;
    if (running) this.toolCalls.set(callId, body);
    else this.toolCalls.delete(callId);
    this.emit({ type: "item", id: `${this.token}:${callId}`, body, final: !running });
  }

  private onPermission(props: Json): void {
    const id = String(props.id);
    const permission = String(props.permission ?? "tool");
    const reply = (answer: "once" | "always" | "reject") =>
      this.server
        .call("POST", `/permission/${encodeURIComponent(id)}/reply`, this.cwd, { reply: answer })
        .catch((error: unknown) => console.error("[opencode] permission reply:", error));
    // OpenCode asks for everything; the thread's mode decides what the user sees.
    if (this.mode === "full-access" || (this.mode === "auto-edit" && permission === "edit")) {
      void reply("once");
      return;
    }
    const metadata = (props.metadata ?? {}) as Json;
    const patterns = Array.isArray(props.patterns) ? (props.patterns as string[]) : [];
    const filepath = typeof metadata.filepath === "string" ? metadata.filepath : null;
    const itemId = `approval:${this.token}:${id}`;
    const request: ItemBody = {
      kind: "approval",
      requestKind:
        permission === "bash" ? "command" : permission === "edit" ? "file_change" : "tool",
      tool: permission,
      title:
        permission === "bash"
          ? "OpenCode wants to run a command"
          : permission === "edit"
            ? "OpenCode wants to edit a file"
            : permission === "external_directory"
              ? "OpenCode wants to work outside this folder"
              : `OpenCode wants to use ${permission}`,
      detail: (filepath ? relative(filepath, this.cwd) : null) ?? (patterns.join("\n") || null),
      diff: typeof metadata.diff === "string" ? truncate(metadata.diff, MAX_OUTPUT) : null,
      reason: null,
      status: "pending",
    };
    this.emit({ type: "item", id: itemId, body: request, final: true });
    this.pending.set(itemId, (response) => {
      const decision = response.kind === "approval" ? response.decision : "deny";
      void reply(
        decision === "approve" ? "once" : decision === "approve-session" ? "always" : "reject",
      );
      this.emit({
        type: "item",
        id: itemId,
        body: {
          ...request,
          status:
            response.kind !== "approval"
              ? "cancelled"
              : decision === "deny"
                ? "denied"
                : "approved",
        },
        final: true,
      });
    });
  }

  private onQuestion(props: Json): void {
    const id = String(props.id);
    const raw = (Array.isArray(props.questions) ? props.questions : []) as Array<{
      question?: string;
      header?: string;
      multiple?: boolean;
      options?: Array<{ label?: string; description?: string }>;
    }>;
    const questions: QuestionSpec[] = raw.map((question) => ({
      question: question.question ?? "",
      header: question.header ?? "",
      multiSelect: Boolean(question.multiple),
      options: (question.options ?? []).map((option) => ({
        label: option.label ?? "",
        description: option.description ?? "",
      })),
    }));
    const itemId = `question:${this.token}:${id}`;
    const body: ItemBody = { kind: "question", questions, answers: null, status: "pending" };
    this.emit({ type: "item", id: itemId, body, final: true });
    this.pending.set(itemId, (response) => {
      if (response.kind !== "question") {
        void this.server
          .call("POST", `/question/${encodeURIComponent(id)}/reject`, this.cwd)
          .catch(() => undefined);
        this.emit({
          type: "item",
          id: itemId,
          body: { ...body, status: "cancelled" },
          final: true,
        });
        return;
      }
      const answers = questions.map((question) =>
        (response.answers[question.question] ?? "").split(", ").filter(Boolean),
      );
      void this.server
        .call("POST", `/question/${encodeURIComponent(id)}/reply`, this.cwd, { answers })
        .catch((error: unknown) => console.error("[opencode] question reply:", error));
      this.emit({
        type: "item",
        id: itemId,
        body: { ...body, answers: response.answers, status: "answered" },
        final: true,
      });
    });
  }

  /**
   * OpenCode went idle. It can say so more than once and send late updates
   * after, so wait for the stream to go quiet before closing the turn.
   */
  private settle(): void {
    if (!this.turnActive || !this.sawBusy || this.settling) return;
    this.settling = true;
    const giveUpAt = Date.now() + 1_500;
    const check = async () => {
      if (Date.now() - this.lastEventAt < 250 && Date.now() < giveUpAt) {
        setTimeout(() => void check(), 100);
        return;
      }
      this.settling = false;
      const status = await this.server
        .call<Record<string, { type?: string }>>("GET", "/session/status", this.cwd)
        .catch(() => null);
      // A steered message can start another step right after an idle.
      if (status?.[this.sessionId]?.type === "busy") return;
      this.completeTurn();
    };
    setTimeout(() => void check(), 100);
  }

  private completeTurn(): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    for (const [partId, segment] of this.texts) {
      if (!segment.text.trim()) continue;
      this.emit({
        type: "item",
        id: `${this.token}:${partId}`,
        body: { kind: segment.kind, text: segment.text, streaming: false },
        final: true,
      });
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
    this.cancelPending();

    let usage: Usage | null = null;
    for (const info of this.turnMessages.values()) {
      const tokens = info.tokens;
      if (!tokens) continue;
      usage ??= { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      const cacheRead = tokens.cache?.read ?? 0;
      usage.inputTokens += (tokens.input ?? 0) + cacheRead + (tokens.cache?.write ?? 0);
      usage.outputTokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
      usage.cachedInputTokens += cacheRead;
    }
    const silent = !this.interrupting && !this.turnError && !this.turnHadOutput;
    const status = this.interrupting
      ? "interrupted"
      : this.turnError || silent
        ? "failed"
        : "completed";
    this.emit({
      type: "turn.completed",
      status,
      usage,
      costUsd:
        this.costs.size > 0 ? [...this.costs.values()].reduce((sum, cost) => sum + cost, 0) : null,
      error:
        status !== "failed"
          ? null
          : (this.turnError ??
            "OpenCode ended the turn without responding. Check it's signed in (`opencode auth login`) and its model works."),
    });
    this.interrupting = false;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.cancelPending();
    this.events.abort();
    const clean = this.closed || code === 0 || code === 143 || signal === "SIGTERM";
    const error = clean
      ? null
      : this.server.stderrTail.trim().slice(-1_500) || `OpenCode exited with ${code ?? signal}`;
    if (this.turnActive) {
      this.turnActive = false;
      this.emit({
        type: "turn.completed",
        status: "failed",
        usage: null,
        costUsd: null,
        error: error ?? "OpenCode exited mid-turn.",
      });
    }
    this.emit({ type: "session.exited", error });
  }
}

function relative(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function toolDetail(input: Json, cwd: string): string | null {
  for (const key of ["command", "filePath", "path", "pattern", "url", "query", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value)
      return key === "filePath" || key === "path" ? relative(value, cwd) : value;
  }
  return null;
}
