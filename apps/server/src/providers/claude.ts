import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemBody, PlanStep, RuntimeMode, ToolKind } from "@agentplane/contracts";
import {
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue, deferred, errorMessage, newId, truncate, withTimeout } from "../util.ts";
import { agentEnvironment, requireBinary } from "./detect.ts";
import type {
  AdapterEvent,
  OpenSessionOptions,
  ProviderAdapter,
  ProviderSession,
  RequestResponse,
} from "./types.ts";

const PERMISSION_MODES: Record<RuntimeMode, PermissionMode> = {
  supervised: "default",
  "auto-edit": "acceptEdits",
  "full-access": "bypassPermissions",
};

const MAX_OUTPUT = 20_000;

export const claudeAdapter: ProviderAdapter = {
  provider: "claude",
  canSteer: true,
  async listModels() {
    const executable = await requireBinary("claude", "Claude Code");
    // A session that never gets a message: enough for Claude Code to start
    // and report its models, without spending a token.
    const input = new AsyncQueue<SDKUserMessage>();
    const probe = query({
      prompt: input,
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: executable,
        env: await agentEnvironment(),
      },
    });
    try {
      const models = await withTimeout(probe.supportedModels(), 30_000);
      return models.map((model) => ({
        id: model.value,
        name: model.displayName,
        description: model.description || null,
        isDefault: model.value === "default",
        aliases: model.resolvedModel ? [model.resolvedModel] : [],
      }));
    } finally {
      input.close();
      probe.close();
    }
  },
  async openSession(options) {
    const executable = await requireBinary("claude", "Claude Code");
    const env = { ...(await agentEnvironment()), ...options.env };
    // Resuming a session whose transcript is gone fails the whole turn; start
    // fresh instead and say so, so the thread's history gets handed over.
    const resumable = options.resumeId
      ? await claudeTranscriptExists(options.resumeId, env)
      : false;
    return new ClaudeSession(
      executable,
      env,
      { ...options, resumeId: resumable ? options.resumeId : null },
      options.resumeId,
    );
  },
};

type ToolCallBody = Extract<ItemBody, { kind: "tool_call" }>;
type StreamBlock = { id: string; kind: "assistant_message" | "reasoning"; text: string };

class ClaudeSession implements ProviderSession {
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly query: Query;
  private readonly emit: (event: AdapterEvent) => void;
  private readonly pending = new Map<string, (response: RequestResponse) => void>();
  private readonly toolCalls = new Map<string, ToolCallBody>();
  private readonly streamBlocks = new Map<number, StreamBlock>();
  private readonly streamedMessages = new Set<string>();
  private currentMessageId: string | null = null;
  private turnActive = false;
  private interrupting = false;
  /** Messages sent mid-turn that Claude hasn't taken in yet (by uuid). */
  private readonly steering = new Set<string>();
  /** Usage across the results one of our turns spans (a late steer runs as its own). */
  private turnUsage = { input: 0, output: 0, cached: 0 };
  /** One plan item per turn; ids must stay unique across resumed sessions. */
  private planItemId = `plan:${newId()}`;
  private stderrTail = "";

  constructor(
    executable: string,
    env: NodeJS.ProcessEnv,
    options: OpenSessionOptions,
    /** The session we were asked to resume, even if its transcript was missing. */
    private readonly requestedResume: string | null = null,
  ) {
    this.emit = options.emit;
    this.query = query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: executable,
        env,
        includePartialMessages: true,
        permissionMode: PERMISSION_MODES[options.runtimeMode],
        // Lets the user switch into full access mid-session; the mode itself is
        // still only bypass when they pick it.
        allowDangerouslySkipPermissions: true,
        canUseTool: this.canUseTool,
        systemPrompt: { type: "preset", preset: "claude_code" },
        ...(options.mcpServers?.length
          ? {
              mcpServers: Object.fromEntries(
                options.mcpServers.map((server) => [
                  server.name,
                  { type: "http" as const, url: server.url, headers: server.headers },
                ]),
              ),
            }
          : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.resumeId ? { resume: options.resumeId } : {}),
        stderr: (data) => {
          this.stderrTail = (this.stderrTail + data).slice(-4_000);
        },
      },
    });
    void this.consume();
  }

  async startTurn(text: string): Promise<void> {
    this.turnActive = true;
    this.interrupting = false;
    this.planItemId = `plan:${newId()}`;
    this.steering.clear();
    this.turnUsage = { input: 0, output: 0, cached: 0 };
    this.input.push({
      type: "user",
      uuid: randomUUID(),
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  }

  /**
   * Claude folds a message that arrives mid-turn into the turn between tool
   * rounds. If no round is left it runs right after as its own turn, which
   * handleResult keeps inside ours.
   */
  async steer(text: string): Promise<boolean> {
    if (!this.turnActive || this.interrupting) return false;
    const uuid = randomUUID();
    this.steering.add(uuid);
    this.input.push({
      type: "user",
      uuid,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.turnActive) return;
    this.interrupting = true;
    for (const [itemId, respond] of this.pending) {
      respond({ kind: "cancel" });
      this.pending.delete(itemId);
    }
    await this.query.interrupt();
  }

  respondToRequest(itemId: string, response: RequestResponse): void {
    const respond = this.pending.get(itemId);
    if (!respond) throw new Error("That request is no longer pending.");
    this.pending.delete(itemId);
    respond(response);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    await this.query.setPermissionMode(PERMISSION_MODES[mode]);
  }

  async close(): Promise<void> {
    for (const respond of this.pending.values()) respond({ kind: "cancel" });
    this.pending.clear();
    this.input.close();
    this.query.close();
  }

  // ─── Permission requests ───────────────────────────────────────────────────

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const isQuestion = toolName === "AskUserQuestion";
    const itemId = `${isQuestion ? "question" : "approval"}:${options.toolUseID ?? newId()}`;
    const answer = deferred<RequestResponse>();
    this.pending.set(itemId, answer.resolve);
    options.signal.addEventListener("abort", () => {
      if (this.pending.delete(itemId)) answer.resolve({ kind: "cancel" });
    });

    const request = isQuestion ? questionBody(input) : approvalBody(toolName, input, options);
    this.emit({ type: "item", id: itemId, body: request, final: true });

    const response = await answer.promise;
    this.emit({ type: "item", id: itemId, body: settle(request, response), final: true });
    return permissionResult(input, response, options.suggestions);
  };

  // ─── Message stream ────────────────────────────────────────────────────────

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.handle(message);
      this.emit({ type: "session.exited", error: null });
    } catch (error) {
      const detail = this.stderrTail.trim();
      const message = detail ? `${errorMessage(error)}\n${detail}` : errorMessage(error);
      if (this.turnActive) {
        this.turnActive = false;
        this.emit({
          type: "turn.completed",
          status: this.interrupting ? "interrupted" : "failed",
          usage: null,
          costUsd: null,
          error: message,
        });
      }
      this.emit({ type: "session.exited", error: message });
    }
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.emit({
            type: "session.ready",
            providerSessionId: message.session_id,
            model: message.model,
            ...(this.requestedResume
              ? { resumed: message.session_id === this.requestedResume }
              : {}),
          });
        }
        return;
      case "stream_event":
        if (message.parent_tool_use_id === null) this.handleStreamEvent(message.event);
        return;
      case "assistant":
        if (message.parent_tool_use_id === null) this.handleAssistant(message.message);
        return;
      case "user":
        this.handleToolResults(message.message.content);
        return;
      case "result":
        this.handleResult(message);
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(event: Extract<SDKMessage, { type: "stream_event" }>["event"]): void {
    switch (event.type) {
      case "message_start":
        this.currentMessageId = event.message.id;
        this.streamBlocks.clear();
        return;
      case "content_block_start": {
        const block = event.content_block;
        if (block.type !== "text" && block.type !== "thinking") return;
        if (!this.currentMessageId) return;
        this.streamedMessages.add(this.currentMessageId);
        this.streamBlocks.set(event.index, {
          id: `${this.currentMessageId}:${event.index}`,
          kind: block.type === "text" ? "assistant_message" : "reasoning",
          text: block.type === "text" ? block.text : block.thinking,
        });
        return;
      }
      case "content_block_delta": {
        const block = this.streamBlocks.get(event.index);
        if (!block) return;
        if (event.delta.type === "text_delta") block.text += event.delta.text;
        else if (event.delta.type === "thinking_delta") block.text += event.delta.thinking;
        else return;
        this.emitStreamBlock(block, false);
        return;
      }
      case "content_block_stop": {
        const block = this.streamBlocks.get(event.index);
        if (!block) return;
        this.streamBlocks.delete(event.index);
        this.emitStreamBlock(block, true);
        return;
      }
      default:
        return;
    }
  }

  private emitStreamBlock(block: StreamBlock, final: boolean): void {
    // Thinking can stream with no visible text; never surface an empty block.
    if (block.text.trim().length === 0) return;
    this.emit({
      type: "item",
      id: block.id,
      body: { kind: block.kind, text: block.text, streaming: !final },
      final,
    });
  }

  private handleAssistant(message: Extract<SDKMessage, { type: "assistant" }>["message"]): void {
    const streamed = this.streamedMessages.has(message.id);
    message.content.forEach((block, index) => {
      if (block.type === "text" && !streamed && block.text.trim()) {
        this.emit({
          type: "item",
          id: `${message.id}:${index}`,
          body: { kind: "assistant_message", text: block.text, streaming: false },
          final: true,
        });
      } else if (block.type === "tool_use") {
        this.handleToolUse(block.id, block.name, block.input as Record<string, unknown>);
      }
    });
  }

  private handleToolUse(id: string, name: string, input: Record<string, unknown>): void {
    if (name === "AskUserQuestion") return; // Rendered as a question item instead.
    if (name === "TodoWrite") {
      this.emit({
        type: "item",
        id: this.planItemId,
        body: { kind: "plan", steps: todoSteps(input) },
        final: true,
      });
      return;
    }
    const body = toolCallBody(name, input);
    this.toolCalls.set(id, body);
    this.emit({ type: "item", id, body, final: false });
  }

  private handleToolResults(content: Extract<SDKMessage, { type: "user" }>["message"]["content"]) {
    if (typeof content === "string") return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const call = this.toolCalls.get(block.tool_use_id);
      if (!call) continue;
      this.toolCalls.delete(block.tool_use_id);
      const output = toolResultText(block.content);
      this.emit({
        type: "item",
        id: block.tool_use_id,
        body: {
          ...call,
          output: output ? truncate(output, MAX_OUTPUT) : null,
          status: block.is_error ? "failed" : "completed",
        },
        final: true,
      });
    }
  }

  private handleResult(message: Extract<SDKMessage, { type: "result" }>): void {
    if (!this.turnActive) return;
    const usage = message.usage;
    const cached = usage.cache_read_input_tokens ?? 0;
    this.turnUsage.input += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + cached;
    this.turnUsage.output += usage.output_tokens;
    this.turnUsage.cached += cached;
    for (const uuid of message.user_message_uuids ?? []) this.steering.delete(uuid);
    const status = this.interrupting
      ? "interrupted"
      : message.subtype === "success" && !message.is_error
        ? "completed"
        : "failed";
    // A steered message missed the last tool round; Claude answers it next.
    if (status === "completed" && this.steering.size > 0) return;
    this.steering.clear();
    this.turnActive = false;
    this.interrupting = false;
    // Tools still open when a turn ends were cut off.
    for (const [id, call] of this.toolCalls) {
      this.emit({ type: "item", id, body: { ...call, status: "failed" }, final: true });
    }
    this.toolCalls.clear();
    this.emit({
      type: "turn.completed",
      status,
      usage: {
        inputTokens: this.turnUsage.input,
        outputTokens: this.turnUsage.output,
        cachedInputTokens: this.turnUsage.cached,
      },
      costUsd: message.total_cost_usd,
      error:
        status === "failed"
          ? message.subtype === "success"
            ? message.result
            : message.errors.join("\n") || message.subtype
          : null,
    });
  }
}

/** Claude Code keeps each session's transcript at <config>/projects/<project>/<id>.jsonl. */
async function claudeTranscriptExists(sessionId: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const projects = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  try {
    const dirs = await readdir(projects, { withFileTypes: true });
    const checks = await Promise.all(
      dirs
        .filter((dir) => dir.isDirectory())
        .map((dir) =>
          access(join(projects, dir.name, `${sessionId}.jsonl`)).then(
            () => true,
            () => false,
          ),
        ),
    );
    return checks.some(Boolean);
  } catch {
    return false;
  }
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: "command",
  BashOutput: "command",
  Edit: "file_change",
  MultiEdit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
  Read: "read",
  NotebookRead: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "subagent",
  Agent: "subagent",
};

function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return TOOL_KINDS[name] ?? "other";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toolDetail(name: string, input: Record<string, unknown>): string | null {
  return (
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    str(input.description) ??
    (name.startsWith("mcp__") ? truncate(JSON.stringify(input), 500) : null)
  );
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  if (name.startsWith("mcp__")) return name.slice("mcp__".length).replace("__", " · ");
  if ((name === "Task" || name === "Agent") && str(input.subagent_type)) {
    return `Agent · ${input.subagent_type}`;
  }
  return name;
}

function toolCallBody(name: string, input: Record<string, unknown>): ToolCallBody {
  return {
    kind: "tool_call",
    tool: name,
    toolKind: toolKind(name),
    title: toolTitle(name, input),
    detail: toolDetail(name, input),
    output: null,
    diff: editDiff(name, input),
    status: "running",
  };
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** A readable before/after for edit tools. Real diffs come from git checkpoints. */
function editDiff(name: string, input: Record<string, unknown>): string | null {
  if (name === "Edit") {
    const before = str(input.old_string) ?? "";
    const after = str(input.new_string) ?? "";
    return truncate(`${prefixLines(before, "-")}\n${prefixLines(after, "+")}`, MAX_OUTPUT);
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const hunks = input.edits.map((edit: Record<string, unknown>) =>
      [
        prefixLines(str(edit.old_string) ?? "", "-"),
        prefixLines(str(edit.new_string) ?? "", "+"),
      ].join("\n"),
    );
    return truncate(hunks.join("\n@@\n"), MAX_OUTPUT);
  }
  if (name === "Write") {
    return truncate(prefixLines(str(input.content) ?? "", "+"), MAX_OUTPUT);
  }
  return null;
}

function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : null))
    .filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

function todoSteps(input: Record<string, unknown>): PlanStep[] {
  if (!Array.isArray(input.todos)) return [];
  return input.todos.map((todo: Record<string, unknown>) => ({
    text: str(todo.content) ?? "",
    status: todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending",
  }));
}

function questionBody(input: Record<string, unknown>): ItemBody {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return {
    kind: "question",
    questions: questions.map((q: Record<string, unknown>) => ({
      question: str(q.question) ?? "",
      header: str(q.header) ?? "",
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : []).map((o: Record<string, unknown>) => ({
        label: str(o.label) ?? "",
        description: str(o.description) ?? "",
      })),
    })),
    answers: null,
    status: "pending",
  };
}

function approvalBody(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): ItemBody {
  const kind = toolKind(toolName);
  return {
    kind: "approval",
    requestKind: kind === "command" ? "command" : kind === "file_change" ? "file_change" : "tool",
    tool: toolName,
    title: options.title ?? `Claude wants to use ${toolName}`,
    detail: toolDetail(toolName, input),
    diff: editDiff(toolName, input),
    reason: options.decisionReason ?? null,
    status: "pending",
  };
}

function settle(request: ItemBody, response: RequestResponse): ItemBody {
  if (request.kind === "question") {
    return response.kind === "question"
      ? { ...request, answers: response.answers, status: "answered" }
      : { ...request, status: "cancelled" };
  }
  if (request.kind === "approval") {
    if (response.kind !== "approval") return { ...request, status: "cancelled" };
    return { ...request, status: response.decision === "deny" ? "denied" : "approved" };
  }
  return request;
}

function permissionResult(
  input: Record<string, unknown>,
  response: RequestResponse,
  suggestions: Parameters<CanUseTool>[2]["suggestions"],
): PermissionResult {
  switch (response.kind) {
    case "question":
      return { behavior: "allow", updatedInput: { ...input, answers: response.answers } };
    case "approval":
      if (response.decision === "deny") {
        return { behavior: "deny", message: "The user denied this action." };
      }
      return {
        behavior: "allow",
        updatedInput: input,
        ...(response.decision === "approve-session" && suggestions
          ? { updatedPermissions: suggestions }
          : {}),
      };
    case "cancel":
      return { behavior: "deny", message: "The request was cancelled.", interrupt: true };
  }
}
