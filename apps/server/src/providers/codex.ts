import { tmpdir } from "node:os";
import type { ItemBody, ItemStatus, RuntimeMode, Usage } from "@agentplane/contracts";
import { SERVER_VERSION } from "../config.ts";
import { errorMessage, truncate, withTimeout } from "../util.ts";
import { agentEnvironment, requireBinary } from "./detect.ts";
import { StdioRpc } from "./jsonrpc.ts";
import type {
  AdapterEvent,
  OpenSessionOptions,
  ProviderAdapter,
  ProviderSession,
  RequestResponse,
} from "./types.ts";

/**
 * Codex speaks JSON-RPC over stdio via `codex app-server`. Only the slice of
 * the protocol we use is typed here; regenerate the full schema with
 * `codex app-server generate-ts` when extending this.
 */
type CodexItem = { type: string; id: string } & Record<string, unknown>;
type TokenBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

const MODES: Record<RuntimeMode, { approvalPolicy: string; sandbox: string }> = {
  supervised: { approvalPolicy: "untrusted", sandbox: "read-only" },
  "auto-edit": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
};

const MAX_OUTPUT = 20_000;

type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
};

export const codexAdapter: ProviderAdapter = {
  provider: "codex",
  canSteer: true,
  async listModels() {
    const executable = await requireBinary("codex", "Codex");
    const rpc: StdioRpc = new StdioRpc(
      executable,
      ["app-server"],
      { cwd: tmpdir(), env: await agentEnvironment() },
      {
        onNotification: () => undefined,
        onRequest: (id) => rpc.respondError(id, -32601, "Not supported while listing models."),
        onExit: () => undefined,
      },
    );
    try {
      await withTimeout(
        rpc.request("initialize", {
          clientInfo: { name: "agentplane", title: "Agentplane", version: SERVER_VERSION },
          capabilities: { experimentalApi: false, requestAttestation: false },
        }),
        20_000,
      );
      rpc.notify("initialized");
      const models: CodexModel[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: CodexModel[]; nextCursor: string | null } = await withTimeout(
          rpc.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }),
          20_000,
        );
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return models
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.model,
          name: model.displayName || model.model,
          description: model.description || null,
          isDefault: model.isDefault,
          aliases: model.id !== model.model ? [model.id] : [],
        }));
    } finally {
      rpc.kill();
    }
  },
  async openSession(options) {
    const executable = await requireBinary("codex", "Codex");
    const session = new CodexSession(
      executable,
      { ...(await agentEnvironment()), ...options.env },
      options,
    );
    options.signal?.addEventListener("abort", () => void session.close(), { once: true });
    await session.start(options);
    return session;
  },
};

class CodexSession implements ProviderSession {
  private readonly rpc: StdioRpc;
  private readonly emit: (event: AdapterEvent) => void;
  private readonly cwd: string;
  private readonly items = new Map<string, ItemBody>();
  private readonly pending = new Map<string, (response: RequestResponse) => void>();
  private mode: RuntimeMode;
  private threadId = "";
  private turnId: string | null = null;
  private turnActive = false;
  private usageTotal: TokenBreakdown | null = null;
  private usageAtTurnStart: TokenBreakdown | null = null;

  constructor(executable: string, env: NodeJS.ProcessEnv, options: OpenSessionOptions) {
    this.emit = options.emit;
    this.cwd = options.cwd;
    this.mode = options.runtimeMode;
    this.rpc = new StdioRpc(
      executable,
      ["app-server"],
      { cwd: options.cwd, env },
      {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (id, method, params) => this.onRequest(id, method, params),
        onExit: (error) => {
          if (this.turnActive) {
            this.turnActive = false;
            this.emit({
              type: "turn.completed",
              status: "failed",
              usage: null,
              costUsd: null,
              error: error ?? "Codex exited mid-turn.",
            });
          }
          this.emit({ type: "session.exited", error });
        },
      },
    );
  }

  async start(options: OpenSessionOptions): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "agentplane", title: "Agentplane", version: SERVER_VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.rpc.notify("initialized");

    // MCP servers go through config overrides on the thread, not argv, so
    // header secrets never show up in `ps`.
    const mcpConfig = options.mcpServers?.length
      ? {
          config: {
            mcp_servers: Object.fromEntries(
              options.mcpServers.map((server) => [
                server.name,
                { url: server.url, http_headers: server.headers },
              ]),
            ),
          },
        }
      : {};
    const base = {
      cwd: options.cwd,
      ...MODES[options.runtimeMode],
      ...(options.model ? { model: options.model } : {}),
    };
    let settings: Record<string, unknown> = { ...base, ...mcpConfig };
    type ThreadResponse = { thread: { id: string }; model: string };
    let response: ThreadResponse;
    let resumed: boolean | undefined;
    if (options.resumeId) {
      try {
        response = await this.rpc.request<ThreadResponse>("thread/resume", {
          threadId: options.resumeId,
          ...settings,
        });
        resumed = true;
      } catch (error) {
        response = await this.rpc.request<ThreadResponse>("thread/start", settings);
        resumed = false;
        this.emit({
          type: "item",
          id: `resume-failed:${response.thread.id}`,
          body: {
            kind: "notice",
            text: `Codex's earlier session couldn't be restored (${errorMessage(error)}), so it starts fresh and gets this thread's history instead.`,
          },
          final: true,
        });
      }
    } else {
      try {
        response = await this.rpc.request<ThreadResponse>("thread/start", settings);
      } catch (error) {
        if (!("config" in settings)) throw error;
        // Tools are a bonus; never let them block the session.
        settings = base;
        response = await this.rpc.request<ThreadResponse>("thread/start", settings);
        this.emit({
          type: "item",
          id: `mcp-failed:${response.thread.id}`,
          body: {
            kind: "notice",
            text: `Codex didn't accept the Composio tools (${errorMessage(error)}); continuing without them.`,
          },
          final: true,
        });
      }
    }
    this.threadId = response.thread.id;
    this.emit({
      type: "session.ready",
      providerSessionId: this.threadId,
      model: response.model,
      ...(resumed === undefined ? {} : { resumed }),
    });
  }

  async startTurn(text: string): Promise<void> {
    this.turnActive = true;
    this.turnId = null;
    this.usageAtTurnStart = this.usageTotal;
    const response = await this.rpc.request<{ turn: { id: string } }>("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: MODES[this.mode].approvalPolicy,
      sandboxPolicy: sandboxPolicy(this.mode, this.cwd),
    });
    this.turnId = response.turn.id;
  }

  /** Codex takes it at its next model request, inside the same turn. */
  async steer(text: string): Promise<boolean> {
    if (!this.turnActive || !this.turnId) return false;
    try {
      await this.rpc.request("turn/steer", {
        threadId: this.threadId,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: this.turnId,
      });
      return true;
    } catch {
      // The turn just ended, or it's a review/compact turn that can't be steered.
      return false;
    }
  }

  /** Earlier conversation as real Responses API history, ahead of the next turn. */
  async injectHistory(
    entries: Array<{ role: "user" | "assistant"; text: string }>,
  ): Promise<boolean> {
    try {
      await this.rpc.request("thread/inject_items", {
        threadId: this.threadId,
        items: entries.map((entry) => ({
          type: "message",
          role: entry.role,
          content: [
            { type: entry.role === "user" ? "input_text" : "output_text", text: entry.text },
          ],
        })),
      });
      return true;
    } catch {
      // Older Codex (method not found) or a rejected item: send it inline instead.
      return false;
    }
  }

  async interrupt(): Promise<void> {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    if (this.turnActive && this.turnId) {
      await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    }
  }

  respondToRequest(itemId: string, response: RequestResponse): void {
    const respond = this.pending.get(itemId);
    if (!respond) throw new Error("That request is no longer pending.");
    this.pending.delete(itemId);
    respond(response);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    // Applied to the next turn via turn/start overrides.
    this.mode = mode;
  }

  async close(): Promise<void> {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    this.rpc.kill();
  }

  // ─── Server → client ───────────────────────────────────────────────────────

  private onNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    switch (method) {
      case "turn/started":
        this.turnId = (p.turn as { id: string }).id;
        return;
      case "item/started":
      case "item/completed": {
        const item = p.item as CodexItem;
        const body = mapItem(item, method === "item/completed");
        if (!body) return;
        this.items.set(item.id, body);
        // Reasoning and messages start empty (and reasoning may stay empty);
        // only surface them once there is text.
        if (isEmptyText(body)) return;
        this.emit({ type: "item", id: item.id, body, final: method === "item/completed" });
        return;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.appendText(p.itemId as string, p.delta as string);
        return;
      case "item/commandExecution/outputDelta":
        this.appendOutput(p.itemId as string, p.delta as string);
        return;
      case "turn/plan/updated": {
        const plan = p.plan as Array<{ step: string; status: string }>;
        this.emit({
          type: "item",
          id: `plan:${p.turnId as string}`,
          body: {
            kind: "plan",
            steps: plan.map((step) => ({
              text: step.step,
              status:
                step.status === "completed"
                  ? "completed"
                  : step.status === "inProgress"
                    ? "in_progress"
                    : "pending",
            })),
          },
          final: true,
        });
        return;
      }
      case "thread/tokenUsage/updated":
        this.usageTotal = (p.tokenUsage as { total: TokenBreakdown }).total;
        return;
      case "error": {
        const error = p.error as { message: string };
        if (p.willRetry) return;
        this.emit({
          type: "item",
          id: `error:${Date.now()}`,
          body: { kind: "error", message: error.message },
          final: true,
        });
        return;
      }
      case "turn/completed": {
        const turn = p.turn as { status: string; error: { message: string } | null };
        this.turnActive = false;
        this.turnId = null;
        this.emit({
          type: "turn.completed",
          status:
            turn.status === "interrupted"
              ? "interrupted"
              : turn.status === "failed"
                ? "failed"
                : "completed",
          usage: usageDelta(this.usageAtTurnStart, this.usageTotal),
          costUsd: null,
          error: turn.error?.message ?? null,
        });
        return;
      }
      default:
        return;
    }
  }

  private appendText(itemId: string, delta: string): void {
    const body = this.items.get(itemId);
    if (!body || (body.kind !== "assistant_message" && body.kind !== "reasoning")) return;
    const next = { ...body, text: body.text + delta, streaming: true };
    this.items.set(itemId, next);
    this.emit({ type: "item", id: itemId, body: next, final: false });
  }

  private appendOutput(itemId: string, delta: string): void {
    const body = this.items.get(itemId);
    if (body?.kind !== "tool_call") return;
    const next = { ...body, output: truncate((body.output ?? "") + delta, MAX_OUTPUT) };
    this.items.set(itemId, next);
    this.emit({ type: "item", id: itemId, body: next, final: false });
  }

  private onRequest(id: number | string, method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval"
    ) {
      this.rpc.respondError(id, -32601, `${method} is not supported by this client yet.`);
      return;
    }
    const isCommand = method === "item/commandExecution/requestApproval";
    const target = this.items.get(p.itemId as string);
    // RPC ids restart with every app-server process, so key on Codex's own ids.
    const itemId = `approval:${String(p.itemId)}${p.approvalId ? `:${String(p.approvalId)}` : ""}`;
    const request: ItemBody = {
      kind: "approval",
      requestKind: isCommand ? "command" : "file_change",
      tool: isCommand ? "shell" : "apply_patch",
      title: isCommand ? "Codex wants to run a command" : "Codex wants to edit files",
      detail: isCommand
        ? ((p.command as string | null | undefined) ?? null)
        : target?.kind === "tool_call"
          ? target.detail
          : null,
      diff: !isCommand && target?.kind === "tool_call" ? target.diff : null,
      reason: (p.reason as string | null | undefined) ?? null,
      status: "pending",
    };
    this.emit({ type: "item", id: itemId, body: request, final: true });
    this.pending.set(itemId, (response) => {
      const decision =
        response.kind !== "approval"
          ? "cancel"
          : response.decision === "approve"
            ? "accept"
            : response.decision === "approve-session"
              ? "acceptForSession"
              : "decline";
      this.rpc.respond(id, { decision });
      this.emit({
        type: "item",
        id: itemId,
        body: {
          ...request,
          status:
            decision === "cancel" ? "cancelled" : decision === "decline" ? "denied" : "approved",
        },
        final: true,
      });
    });
  }
}

function isEmptyText(body: ItemBody): boolean {
  return (
    (body.kind === "assistant_message" || body.kind === "reasoning") && body.text.trim() === ""
  );
}

function sandboxPolicy(mode: RuntimeMode, cwd: string): Record<string, unknown> {
  switch (mode) {
    case "supervised":
      return { type: "readOnly", networkAccess: false };
    case "auto-edit":
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "full-access":
      return { type: "dangerFullAccess" };
  }
}

function itemStatus(status: unknown, exitCode?: unknown): ItemStatus {
  if (status === "inProgress") return "running";
  if (status === "completed") {
    return typeof exitCode === "number" && exitCode !== 0 ? "failed" : "completed";
  }
  return "failed";
}

function mapItem(item: CodexItem, final: boolean): ItemBody | null {
  switch (item.type) {
    case "agentMessage":
    case "plan":
      return { kind: "assistant_message", text: String(item.text ?? ""), streaming: !final };
    case "reasoning": {
      const summary = (item.summary as string[] | undefined) ?? [];
      const content = (item.content as string[] | undefined) ?? [];
      const text = (summary.length > 0 ? summary : content).join("\n\n");
      return { kind: "reasoning", text, streaming: !final };
    }
    case "commandExecution": {
      const output = item.aggregatedOutput as string | null;
      return {
        kind: "tool_call",
        tool: "shell",
        toolKind: "command",
        title: "Shell",
        detail: String(item.command ?? ""),
        output: output ? truncate(output, MAX_OUTPUT) : null,
        diff: null,
        status: itemStatus(item.status, item.exitCode),
      };
    }
    case "fileChange": {
      const changes = (item.changes as Array<{ path: string; diff: string }> | undefined) ?? [];
      return {
        kind: "tool_call",
        tool: "apply_patch",
        toolKind: "file_change",
        title: changes.length === 1 ? "Edit" : `Edit ${changes.length} files`,
        detail: changes.map((change) => change.path).join(", ") || null,
        output: null,
        diff: truncate(
          changes.map((change) => `--- ${change.path}\n${change.diff}`).join("\n"),
          MAX_OUTPUT,
        ),
        status: itemStatus(item.status),
      };
    }
    case "mcpToolCall": {
      const result = item.result ?? item.error ?? null;
      return {
        kind: "tool_call",
        tool: `${String(item.server)}.${String(item.tool)}`,
        toolKind: "mcp",
        title: `${String(item.server)} · ${String(item.tool)}`,
        detail: truncate(JSON.stringify(item.arguments ?? {}), 500),
        output: result ? truncate(JSON.stringify(result, null, 2), MAX_OUTPUT) : null,
        diff: null,
        status: itemStatus(item.status),
      };
    }
    case "dynamicToolCall":
      return {
        kind: "tool_call",
        tool: String(item.tool),
        toolKind: "other",
        title: String(item.tool),
        detail: truncate(JSON.stringify(item.arguments ?? {}), 500),
        output: null,
        diff: null,
        status: itemStatus(item.status),
      };
    case "webSearch":
      return {
        kind: "tool_call",
        tool: "web_search",
        toolKind: "web",
        title: "Web search",
        detail: String(item.query ?? ""),
        output: null,
        diff: null,
        status: final ? "completed" : "running",
      };
    default:
      return null;
  }
}

function usageDelta(start: TokenBreakdown | null, end: TokenBreakdown | null): Usage | null {
  if (!end) return null;
  return {
    inputTokens: end.inputTokens - (start?.inputTokens ?? 0),
    outputTokens: end.outputTokens - (start?.outputTokens ?? 0),
    cachedInputTokens: end.cachedInputTokens - (start?.cachedInputTokens ?? 0),
  };
}
