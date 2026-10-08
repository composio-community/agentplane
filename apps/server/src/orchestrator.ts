import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type {
  AgentSession,
  ApprovalDecision,
  EventBody,
  Item,
  ItemBody,
  ItemOf,
  McpServerConfig,
  MethodParams,
  Project,
  ShellSnapshot,
  Thread,
  ThreadSnapshot,
  Turn,
} from "@agentplane/contracts";
import { describeRule, type PermissionRule, ruleFor } from "@agentplane/contracts";
import { changes, diff, dropCheckpoints, RevertConflict, revert, snapshot } from "./checkpoints.ts";
import type { ServerConfig } from "./config.ts";
import { createWorktree, isGitRepo } from "./git.ts";
import { buildHandoff, type Handoff, type HandoffMode, inlineHandoff } from "./handoff.ts";
import { agentEnvironment } from "./providers/detect.ts";
import { classifySetup } from "./providers/setup.ts";
import type { AdapterEvent, ProviderAdapter, ProviderSession } from "./providers/types.ts";
import type { RuleBook } from "./rules.ts";
import { gitStatus, ShipError, type ShipRequest, type ShipResult, ship } from "./ship.ts";
import type { Store } from "./store.ts";
import { errorMessage, newId } from "./util.ts";
import { describeSetup, prepareWorktree, runSetup } from "./worktree-setup.ts";

/** Each worktree thread gets PORT_STEP ports starting here. */
const PORT_START = 4100;
const PORT_STEP = 10;
/** Streaming items are pushed to clients at most this often. */
const LIVE_PUSH_INTERVAL_MS = 50;
/** Provider processes are released after this long without a turn. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_TITLE = "New thread";

type ItemMeta = { order: number; createdAt: number; turnId: string | null };

export class UserError extends Error {}

/**
 * Turns commands into events and provider activity into events. Everything
 * the UI sees flows through `store.commit` (durable) or `onLive` (streaming).
 */
export class Orchestrator {
  private readonly sessions = new Map<string, Promise<ProviderSession>>();
  /**
   * Which session is current for each thread. Events from a session that has
   * since been closed or replaced (agent or model switch) are dropped.
   */
  private readonly generations = new Map<string, number>();
  private generation = 0;
  /** Threads whose agent asked to resume but got a fresh session: it needs the full history. */
  private readonly freshSessions = new Set<string>();
  /** Turns whose prompt reached the agent (so its session now contains everything before them). */
  private readonly delivered = new Set<string>();
  /** Session ids learned before any turn ran; saved once one does (empty sessions can't be resumed). */
  private readonly unsavedSessionIds = new Map<string, string>();
  /** Sessions still starting up (installing, signing in), so they can be abandoned. */
  private readonly opening = new Map<string, AbortController>();
  private readonly activeTurns = new Map<string, string>();
  private readonly pendingRequests = new Map<string, Set<string>>();
  private readonly liveItems = new Map<string, Map<string, Item>>();
  private readonly liveTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly itemMeta = new Map<string, ItemMeta>();
  /** Worktree setup in progress (copying env files, cloning deps); sessions wait for it. */
  private readonly setups = new Map<string, Promise<void>>();
  /** The "after" checkpoint still being taken, per thread (the next turn waits for it). */
  private readonly checkpointing = new Map<string, Promise<void>>();
  /** Something the agent must hear with the next message (e.g. a revert). */
  private readonly agentNotes = new Map<string, string>();
  /** A queued message the user stopped the turn for, per thread; it goes next. */
  private readonly sendAfterStop = new Map<string, string>();
  /** Approvals answered by a saved rule, so the settled item can say which. */
  private readonly autoApproved = new Map<string, string>();
  /** Last running cost total reported by each thread's current provider session. */
  private readonly sessionCost = new Map<string, number>();
  private order: number;

  constructor(
    private readonly store: Store,
    private readonly config: ServerConfig,
    private readonly onLive: (item: Item) => void,
    /** Shared with the agent catalog, which adds registry agents as they load. */
    private readonly providers: Record<string, ProviderAdapter>,
    private readonly extras: {
      /** MCP servers every agent session gets (Composio tools). */
      toolServers?: () => Promise<McpServerConfig[]>;
      /** Project permission rules, shared by every agent. */
      rules?: RuleBook;
      /** Display names for agents, for handoff notes. */
      agentLabel?: (provider: string) => string;
      /** Whether the app can open a sign-in terminal for an agent. */
      canSignIn?: (provider: string) => boolean;
      /** Setup commands the user approved, per project. */
      setupTrust?: {
        trusted: (projectId: string, command: string) => boolean;
        trust: (projectId: string, command: string) => void;
      };
    } = {},
  ) {
    this.order = store.maxItemOrder();
    this.recover();
  }

  /** Nothing survives a restart mid-turn; settle whatever was in flight. */
  private recover(): void {
    const events: EventBody[] = [];
    const now = Date.now();
    for (const thread of this.store.listThreads()) {
      for (const turn of this.store.getTurns(thread.id)) {
        if (turn.status === "running") {
          events.push({
            type: "turn.updated",
            turn: { ...turn, status: "interrupted", completedAt: now, error: "Server restarted" },
          });
        }
      }
      for (const item of this.store.getItems(thread.id)) {
        const settled = settleOnRestart(item);
        if (settled) events.push({ type: "item.upserted", item: settled });
      }
      if (thread.status === "running" || thread.status === "needs-input") {
        events.push({
          type: "thread.updated",
          thread: { ...thread, status: "idle", updatedAt: now },
        });
      }
    }
    this.store.commit(events);
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  shell(): ShellSnapshot {
    return {
      seq: this.store.latestSeq(),
      projects: this.store.listProjects(),
      threads: this.store.listThreads(),
    };
  }

  threadSnapshot(threadId: string): ThreadSnapshot {
    const thread = this.requireThread(threadId);
    const items = new Map(this.store.getItems(threadId).map((item) => [item.id, item]));
    for (const item of this.liveItems.get(threadId)?.values() ?? []) items.set(item.id, item);
    return {
      seq: this.store.latestSeq(),
      thread,
      turns: this.store.getTurns(threadId),
      items: [...items.values()].sort((a, b) => a.order - b.order),
    };
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  async createProject(rawPath: string): Promise<Project> {
    const path = resolve(rawPath.replace(/^~(?=$|\/)/, homedir()));
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      // Reported below.
    }
    if (!isDirectory) throw new UserError(`Not a directory: ${path}`);
    const existing = this.store.listProjects().find((project) => project.path === path);
    if (existing) return existing;
    const project: Project = {
      id: newId(),
      name: basename(path),
      path,
      isGitRepo: await isGitRepo(path),
      createdAt: Date.now(),
    };
    this.store.commit([{ type: "project.created", project }]);
    return project;
  }

  async deleteProject(projectId: string): Promise<void> {
    const threads = this.store.listThreadsForProject(projectId);
    await Promise.all(threads.map((thread) => this.closeSession(thread.id)));
    this.store.commit([
      ...threads.map((thread): EventBody => ({ type: "thread.deleted", threadId: thread.id })),
      { type: "project.deleted", projectId },
    ]);
  }

  // ─── Threads ───────────────────────────────────────────────────────────────

  async createThread(
    params: MethodParams<"thread.create">,
    extra: { title?: string; origin?: string } = {},
  ): Promise<Thread> {
    const project = this.store.getProject(params.projectId);
    if (!project) throw new UserError("Project not found.");
    const id = newId();
    let cwd = project.path;
    let branch: string | null = null;
    let portBase: number | null = null;
    if (params.worktree) {
      if (!project.isGitRepo) throw new UserError("Worktrees need the project to be a git repo.");
      try {
        const worktree = await createWorktree({
          repoPath: project.path,
          worktreesDir: this.config.worktreesDir,
          shortId: id.slice(0, 8),
        });
        cwd = worktree.path;
        branch = worktree.branch;
        portBase = this.freePortBase();
      } catch (error) {
        throw new UserError(
          `Couldn't create a worktree (does the repo have at least one commit?): ${errorMessage(error)}`,
        );
      }
    }
    const now = Date.now();
    const thread: Thread = {
      id,
      projectId: project.id,
      title: extra.title ?? DEFAULT_TITLE,
      origin: extra.origin ?? null,
      portBase,
      provider: params.provider,
      model: params.model,
      runtimeMode: params.runtimeMode,
      status: "idle",
      cwd,
      branch,
      providerSessionId: null,
      costUsd: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.commit([{ type: "thread.created", thread }]);
    if (params.worktree) this.startSetup(thread, project.path);
    return thread;
  }

  /** Lowest port block no other thread holds. */
  private freePortBase(): number {
    const taken = new Set(this.store.listThreads().map((thread) => thread.portBase));
    let base = PORT_START;
    while (taken.has(base)) base += PORT_STEP;
    return base;
  }

  /** Where a thread's terminals run, with the same ports its agent gets. */
  terminalTarget(threadId: string): { cwd: string; env: Record<string, string> } {
    const thread = this.requireThread(threadId);
    return { cwd: thread.cwd, env: this.threadEnv(thread) };
  }

  private threadEnv(thread: Thread): Record<string, string> {
    return thread.portBase
      ? {
          PORT: String(thread.portBase),
          AGENTPLANE_PORT_BASE: String(thread.portBase),
          AGENTPLANE_PORT_COUNT: String(PORT_STEP),
        }
      : {};
  }

  /** Copy env files and clone deps into the new worktree, in the background. */
  private startSetup(thread: Thread, repoPath: string): void {
    const setup = (async () => {
      const env = { ...(await agentEnvironment()), ...this.threadEnv(thread) };
      const report = await prepareWorktree({
        repoPath,
        worktreePath: thread.cwd,
        env,
        trusted: (command) => this.extras.setupTrust?.trusted(thread.projectId, command) ?? false,
      });
      if (!this.store.getThread(thread.id)) return;
      this.store.commit([
        {
          type: "item.upserted",
          item: this.toItem(thread.id, `setup:${thread.id}`, {
            kind: "notice",
            text: describeSetup(report, thread.portBase ?? null),
          }),
        },
        ...(report.pendingSetup
          ? [
              {
                type: "item.upserted" as const,
                item: this.toItem(thread.id, `setup-request:${thread.id}`, {
                  kind: "setup_request",
                  command: report.pendingSetup,
                  status: "pending",
                  output: null,
                }),
              },
            ]
          : []),
      ]);
    })()
      .catch((error) => console.error("[setup]", errorMessage(error)))
      .finally(() => this.setups.delete(thread.id));
    this.setups.set(thread.id, setup);
  }

  /** Run (once, or always for this project) or skip a project's worktree setup command. */
  async respondSetup(
    threadId: string,
    itemId: string,
    decision: "run" | "always" | "skip",
  ): Promise<void> {
    const thread = this.requireThread(threadId);
    const item = this.store.getItem(threadId, itemId);
    if (item?.kind !== "setup_request" || item.status !== "pending") {
      throw new UserError("That setup request was already answered.");
    }
    if (decision === "skip") {
      this.store.commit([{ type: "item.upserted", item: { ...item, status: "skipped" } }]);
      return;
    }
    if (decision === "always") this.extras.setupTrust?.trust(thread.projectId, item.command);
    this.store.commit([{ type: "item.upserted", item: { ...item, status: "running" } }]);
    const env = { ...(await agentEnvironment()), ...this.threadEnv(thread) };
    const result = await runSetup(item.command, thread.cwd, env);
    if (!this.store.getThread(threadId)) return;
    this.store.commit([
      {
        type: "item.upserted",
        item: { ...item, status: result.ok ? "done" : "failed", output: result.output || null },
      },
    ]);
  }

  async deleteThread(threadId: string): Promise<void> {
    const thread = this.requireThread(threadId);
    await this.closeSession(threadId);
    this.sendAfterStop.delete(threadId);
    this.store.commit([{ type: "thread.deleted", threadId }]);
    void dropCheckpoints(thread.cwd, threadId);
  }

  renameThread(threadId: string, title: string): void {
    this.store.commit([this.threadPatch(threadId, { title })]);
  }

  /**
   * Starts a turn, or queues the message while the agent is still working (the
   * queue runs as turns complete). Commits and returns; the provider work runs
   * in the background and streams back as events.
   */
  sendMessage(threadId: string, text: string): { queued: boolean } {
    if (this.activeTurns.has(threadId)) {
      const thread = this.requireThread(threadId);
      const queue = [...(thread.queue ?? []), { id: newId(), text, createdAt: Date.now() }];
      this.store.commit([this.threadPatch(threadId, { queue })]);
      return { queued: true };
    }
    this.startTurn(threadId, text);
    return { queued: false };
  }

  /** Take a message off the queue; its text comes back so it can be edited. */
  unqueue(threadId: string, messageId: string): { text: string } {
    const thread = this.requireThread(threadId);
    const message = thread.queue?.find((queued) => queued.id === messageId);
    if (!message) throw new UserError("That message isn't queued any more.");
    const queue = (thread.queue ?? []).filter((queued) => queued.id !== messageId);
    this.store.commit([this.threadPatch(threadId, { queue })]);
    return { text: message.text };
  }

  /**
   * Deliver a queued message now. An agent that can take it mid-turn gets it
   * at its next step; any other is stopped and the message goes next.
   */
  async sendQueued(
    threadId: string,
    messageId: string,
  ): Promise<{ delivery: "steered" | "interrupted" | "started" | "queued" }> {
    const message = this.requireThread(threadId).queue?.find((queued) => queued.id === messageId);
    if (!message) throw new UserError("That message isn't queued any more.");
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) {
      this.unqueue(threadId, messageId);
      this.startTurn(threadId, message.text);
      return { delivery: "started" };
    }
    const pending = this.opening.has(threadId) ? undefined : this.sessions.get(threadId);
    const session = pending ? await pending.catch(() => null) : null;
    if (session?.steer) {
      if (!(await session.steer(message.text))) {
        // The turn is ending; the message stays first in line for the next one.
        return { delivery: "queued" };
      }
      const thread = this.requireThread(threadId);
      this.store.commit([
        this.threadPatch(threadId, {
          queue: (thread.queue ?? []).filter((queued) => queued.id !== messageId),
        }),
        {
          type: "item.upserted",
          item: this.toItem(
            threadId,
            `user:${newId()}`,
            { kind: "user_message", text: message.text, steered: true },
            turnId,
          ),
        },
      ]);
      return { delivery: "steered" };
    }
    this.sendAfterStop.set(threadId, messageId);
    await this.interrupt(threadId);
    return { delivery: "interrupted" };
  }

  /** After a turn ends: start the next queued message, if it should go on its own. */
  private drainQueue(threadId: string, status: Turn["status"]): void {
    const chosen = this.sendAfterStop.get(threadId);
    this.sendAfterStop.delete(threadId);
    const thread = this.store.getThread(threadId);
    if (!thread?.queue?.length || this.activeTurns.has(threadId)) return;
    // After a stop or a failure the queue waits for the user, unless they
    // stopped the turn to send one of these.
    const next = chosen
      ? thread.queue.find((queued) => queued.id === chosen)
      : status === "completed"
        ? thread.queue[0]
        : undefined;
    if (!next) return;
    this.store.commit([
      this.threadPatch(threadId, {
        queue: thread.queue.filter((queued) => queued.id !== next.id),
      }),
    ]);
    this.startTurn(threadId, next.text);
  }

  private startTurn(threadId: string, text: string): void {
    const thread = this.requireThread(threadId);
    if (this.activeTurns.has(threadId)) {
      throw new UserError("The agent is still working. Wait for it or interrupt it first.");
    }
    const turnId = newId();
    const now = Date.now();
    this.activeTurns.set(threadId, turnId);
    this.clearIdleTimer(threadId);
    const turn: Turn = {
      id: turnId,
      threadId,
      provider: thread.provider,
      status: "running",
      startedAt: now,
      completedAt: null,
      usage: null,
      error: null,
    };
    this.store.commit([
      { type: "turn.updated", turn },
      {
        type: "item.upserted",
        item: this.toItem(threadId, `user:${turnId}`, { kind: "user_message", text }),
      },
      this.threadPatch(threadId, {
        status: "running",
        ...(thread.title === DEFAULT_TITLE ? { title: titleFrom(text) } : {}),
      }),
    ]);
    void this.runTurn(thread, turnId, text);
  }

  private async runTurn(thread: Thread, turnId: string, text: string): Promise<void> {
    const threadId = thread.id;
    try {
      const session = await this.ensureSession(thread);
      const current = this.store.getThread(threadId) ?? thread;
      await this.checkpointBefore(current, turnId);
      const handoff = this.planHandoff(current, turnId);
      let prompt = text;
      let native = false;
      if (handoff) {
        native = (await session.injectHistory?.(handoff.entries).catch(() => false)) ?? false;
        if (!native) prompt = inlineHandoff(handoff, text);
      }
      const note = this.agentNotes.get(threadId);
      if (note) {
        this.agentNotes.delete(threadId);
        prompt = `${note}\n\n${prompt}`;
      }
      await session.startTurn(prompt);
      this.delivered.add(turnId);
      this.freshSessions.delete(threadId);
      const events: EventBody[] = [];
      const sessionId = this.unsavedSessionIds.get(threadId);
      if (sessionId) {
        this.unsavedSessionIds.delete(threadId);
        events.push(this.threadPatch(threadId, { providerSessionId: sessionId }));
      }
      if (handoff) {
        const userMessage = this.store.getItem(threadId, `user:${turnId}`);
        events.push({
          type: "item.upserted",
          item: {
            id: `handoff:${turnId}`,
            threadId,
            turnId,
            // Shown just above the message it came with.
            order: (userMessage?.order ?? this.order) - 0.5,
            createdAt: Date.now(),
            kind: "handoff",
            from: handoff.from,
            to: this.agentLabel(current.provider),
            mode: handoff.mode,
            included: handoff.included,
            omitted: handoff.omitted,
            native,
          },
        });
      }
      this.store.commit(events);
    } catch (error) {
      // The user may have stopped (or deleted) the thread while it started.
      if (this.activeTurns.get(threadId) !== turnId) return;
      this.completeTurn(threadId, {
        type: "turn.completed",
        status: "failed",
        usage: null,
        costUsd: null,
        error: errorMessage(error),
      });
    }
  }

  // ─── Checkpoints: what each turn changed, and putting it back ──────────────

  private async checkpointBefore(thread: Thread, turnId: string): Promise<void> {
    await this.checkpointing.get(thread.id);
    const before = await snapshot(thread.cwd, `refs/agentplane/${thread.id}/${turnId}/before`);
    const turn = this.store.getTurn(turnId);
    if (!before || !turn || this.activeTurns.get(thread.id) !== turnId) return;
    this.store.commit([
      {
        type: "turn.updated",
        turn: { ...turn, checkpoint: { before, after: null, files: [], reverted: false } },
      },
    ]);
  }

  private checkpointAfter(threadId: string, turnId: string): void {
    const run = (async () => {
      const thread = this.store.getThread(threadId);
      const turn = this.store.getTurn(turnId);
      if (!thread || !turn?.checkpoint) return;
      const after = await snapshot(thread.cwd, `refs/agentplane/${threadId}/${turnId}/after`);
      if (!after) return;
      const files = await changes(thread.cwd, turn.checkpoint.before, after).catch(() => []);
      const latest = this.store.getTurn(turnId);
      if (!latest?.checkpoint) return;
      this.store.commit([
        {
          type: "turn.updated",
          turn: { ...latest, checkpoint: { ...latest.checkpoint, after, files } },
        },
      ]);
    })()
      .catch((error) => console.error("[checkpoint]", errorMessage(error)))
      .finally(() => {
        if (this.checkpointing.get(threadId) === run) this.checkpointing.delete(threadId);
      });
    this.checkpointing.set(threadId, run);
  }

  private settledCheckpoint(threadId: string, turnId: string) {
    const thread = this.requireThread(threadId);
    const checkpoint = this.store.getTurn(turnId)?.checkpoint;
    if (!checkpoint?.after) {
      throw new UserError("This turn has no recorded changes (not a git repo, or still running).");
    }
    return { thread, checkpoint: { ...checkpoint, after: checkpoint.after } };
  }

  async turnDiff(threadId: string, turnId: string) {
    await this.checkpointing.get(threadId);
    const { thread, checkpoint } = this.settledCheckpoint(threadId, turnId);
    return { files: await diff(thread.cwd, checkpoint.before, checkpoint.after) };
  }

  async revertTurn(
    threadId: string,
    turnId: string,
    overwrite = false,
  ): Promise<{ files: string[] }> {
    if (this.activeTurns.has(threadId)) {
      throw new UserError("Stop the agent before reverting; it's still working.");
    }
    await this.checkpointing.get(threadId);
    const { thread, checkpoint } = this.settledCheckpoint(threadId, turnId);
    if (checkpoint.reverted) throw new UserError("This turn was already reverted.");
    const files = await revert(thread.cwd, checkpoint.before, checkpoint.after, overwrite).catch(
      (error: unknown) => {
        throw error instanceof RevertConflict ? new UserError(error.message) : error;
      },
    );
    const turn = this.store.getTurn(turnId);
    if (!turn?.checkpoint) return { files };
    const list = files.map((file) => `\`${file}\``).join(", ");
    this.store.commit([
      {
        type: "turn.updated",
        turn: { ...turn, checkpoint: { ...turn.checkpoint, reverted: true } },
      },
      {
        type: "item.upserted",
        item: this.toItem(threadId, `revert:${turnId}`, {
          kind: "notice",
          text: `Reverted a turn: put back ${files.length === 1 ? "1 file" : `${files.length} files`} (${list}).`,
        }),
      },
    ]);
    this.agentNotes.set(
      threadId,
      `[Note from the user: I reverted the changes you made in an earlier turn. These files are back to how they were before it: ${files.join(", ")}. Re-read them before relying on what you wrote.]`,
    );
    return { files };
  }

  // ─── Shipping: commit, push and open a PR from a thread ─────────────────────

  async ship(threadId: string, request: ShipRequest): Promise<ShipResult> {
    const thread = this.requireThread(threadId);
    if (this.activeTurns.has(threadId)) {
      throw new UserError("Wait for the agent to finish (or stop it) before committing.");
    }
    let result: ShipResult;
    try {
      result = await ship(thread.cwd, request);
    } catch (error) {
      throw error instanceof ShipError ? new UserError(error.message) : error;
    }
    const branch = result.branch ?? (await gitStatus(thread.cwd)).branch;
    const done = [
      result.sha ? `Committed \`${result.sha}\`${branch ? ` on \`${branch}\`` : ""}` : null,
      result.pushed ? (result.sha ? "pushed" : `Pushed \`${branch ?? "HEAD"}\``) : null,
      result.prUrl ? `opened [a pull request](${result.prUrl})` : null,
    ].filter(Boolean);
    if (done.length === 0) return result;
    this.store.commit([
      ...(result.branch && thread.branch !== result.branch
        ? [this.threadPatch(threadId, { branch: result.branch })]
        : []),
      {
        type: "item.upserted",
        item: this.toItem(threadId, `ship:${newId()}`, {
          kind: "notice",
          text: `${done.join(" · ")}.`,
        }),
      },
    ]);
    const note = `[Note from the user: ${[
      result.sha ? `I committed the changes so far as ${result.sha}` : null,
      branch ? `on branch ${branch}` : null,
      result.pushed ? "and pushed it" : null,
      result.prUrl ? `; the pull request is ${result.prUrl}` : null,
    ]
      .filter(Boolean)
      .join(" ")}.]`;
    const earlier = this.agentNotes.get(threadId);
    this.agentNotes.set(threadId, earlier ? `${earlier}\n${note}` : note);
    return result;
  }

  private agentLabel(provider: string): string {
    return (this.extras.agentLabel ?? ((id: string) => id))(provider);
  }

  /**
   * What the thread's current agent is missing: everything newer than what
   * its own native session holds. Nothing if it never left; the delta if it's
   * coming back to its old session; everything if its session is new or was
   * lost on the way back.
   */
  private planHandoff(thread: Thread, turnId: string): (Handoff & { mode: HandoffMode }) | null {
    const record = thread.agentSessions?.[thread.provider];
    const fallback = this.freshSessions.has(thread.id);
    const seen = fallback
      ? 0
      : record
        ? record.sessionId
          ? record.seenThrough
          : 0
        : // A thread from before per-agent tracking: its one agent already has it all.
          // (With tracking, a missing record means this agent is new here.)
          !thread.agentSessions && thread.providerSessionId
          ? Number.POSITIVE_INFINITY
          : 0;
    const missing = this.store
      .getItems(thread.id)
      .filter((item) => item.order > seen && item.turnId !== turnId);
    if (missing.length === 0) return null;
    const mode: HandoffMode = fallback ? "fallback" : seen === 0 ? "full" : "delta";
    const handoff = buildHandoff({
      thread,
      items: missing,
      turns: this.store.getTurns(thread.id),
      agentLabel: (provider) => this.agentLabel(provider),
      mode,
    });
    return handoff ? { ...handoff, mode } : null;
  }

  /** The thread's per-agent sessions, with the current agent's position brought up to date. */
  private agentSessions(thread: Thread, seenThrough?: number): Record<string, AgentSession> {
    const records = { ...(thread.agentSessions ?? {}) };
    const previous = records[thread.provider];
    records[thread.provider] = {
      sessionId: thread.providerSessionId,
      model: thread.model,
      seenThrough:
        seenThrough ?? previous?.seenThrough ?? (thread.providerSessionId ? this.order : 0),
    };
    return records;
  }

  /** Send the thread's last message again, e.g. after signing in or switching agents. */
  retry(threadId: string): void {
    const last = this.store.getItems(threadId).findLast((item) => item.kind === "user_message");
    if (last?.kind !== "user_message") throw new UserError("There's no message to retry yet.");
    this.startTurn(threadId, last.text);
  }

  async interrupt(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!this.activeTurns.has(threadId)) return;
    if (!session || this.opening.has(threadId)) {
      // Still starting (e.g. waiting for a sign-in): end the turn, then
      // abandon the start.
      this.completeTurn(threadId, {
        type: "turn.completed",
        status: "interrupted",
        usage: null,
        costUsd: null,
        error: null,
      });
      void this.closeSession(threadId);
      return;
    }
    const turnId = this.activeTurns.get(threadId);
    await (await session).interrupt();
    // If the provider never acknowledges, don't leave the thread stuck running.
    setTimeout(() => {
      if (turnId && this.activeTurns.get(threadId) === turnId) {
        this.completeTurn(threadId, {
          type: "turn.completed",
          status: "interrupted",
          usage: null,
          costUsd: null,
          error: null,
        });
      }
    }, 10_000);
  }

  /**
   * Start the agent before the first message: spawning and initializing a
   * CLI costs seconds, and doing it while the user types hides that. Unused
   * sessions are released by the idle timer. Failures surface on send.
   */
  prewarm(threadId: string): void {
    const thread = this.store.getThread(threadId);
    if (!thread || this.sessions.has(threadId)) return;
    this.ensureSession(thread).then(
      () => {
        if (!this.activeTurns.has(threadId)) this.scheduleIdleClose(threadId);
      },
      () => undefined,
    );
  }

  /**
   * Hand the thread to another agent. Sessions don't carry across agents, so
   * the next message brings the new one up to speed with the thread so far;
   * the folder (and any worktree changes) stays exactly as it is.
   */
  async setProvider(threadId: string, provider: string, model: string | null): Promise<void> {
    const thread = this.requireThread(threadId);
    if (this.activeTurns.has(threadId)) {
      throw new UserError("Wait for the agent to finish (or stop it) before switching agents.");
    }
    if (!this.providers[provider]) throw new UserError(`Unknown agent: ${provider}`);
    if (provider === thread.provider) {
      await this.setModel(threadId, model);
      return;
    }
    const hasHistory = this.store.getItems(threadId).some((item) => item.kind === "user_message");
    await this.closeSession(threadId);
    // Remember where this agent's session is, so switching back resumes it.
    const records = this.agentSessions(this.requireThread(threadId));
    const target = records[provider];
    const from = this.agentLabel(thread.provider);
    const to = this.agentLabel(provider);
    this.store.commit([
      this.threadPatch(threadId, {
        provider,
        model: model ?? target?.model ?? null,
        providerSessionId: target?.sessionId ?? null,
        agentSessions: records,
      }),
      {
        type: "item.upserted",
        item: this.toItem(threadId, `switch:${newId()}`, {
          kind: "notice",
          text: !hasHistory
            ? `Switched from ${from} to ${to}.`
            : target?.sessionId
              ? `Switched back to ${to}, which picks up its earlier session. Your next message catches it up on what happened since; the files are where ${from} left them.`
              : `Switched from ${from} to ${to}. Your next message gives ${to} this thread's history; the files are where ${from} left them.`,
        }),
      },
    ]);
    this.prewarm(threadId);
  }

  /**
   * Switch the thread's model. Agents pick a model when their session starts,
   * so the session is restarted; it resumes the same conversation.
   */
  async setModel(threadId: string, model: string | null): Promise<void> {
    const thread = this.requireThread(threadId);
    if (this.activeTurns.has(threadId)) {
      throw new UserError("Wait for the agent to finish (or stop it) before switching models.");
    }
    if (thread.model === model) return;
    this.store.commit([this.threadPatch(threadId, { model })]);
    await this.closeSession(threadId);
    this.prewarm(threadId);
  }

  async setRuntimeMode(params: MethodParams<"thread.setRuntimeMode">): Promise<void> {
    this.store.commit([this.threadPatch(params.threadId, { runtimeMode: params.runtimeMode })]);
    const session = this.sessions.get(params.threadId);
    if (session) await (await session).setRuntimeMode(params.runtimeMode);
  }

  async respondApproval(threadId: string, itemId: string, decision: ApprovalDecision) {
    await this.respond(threadId, itemId, { kind: "approval", decision });
  }

  async respondQuestion(threadId: string, itemId: string, answers: Record<string, string>) {
    await this.respond(threadId, itemId, { kind: "question", answers });
  }

  /** Approve this request and save a project rule so its kind is approved for every agent. */
  async approveAlways(threadId: string, itemId: string): Promise<PermissionRule> {
    const thread = this.requireThread(threadId);
    const item = this.store.getItem(threadId, itemId);
    if (item?.kind !== "approval" || item.status !== "pending") {
      throw new UserError("That request is no longer pending.");
    }
    const rules = this.extras.rules;
    const draft = ruleFor(item);
    if (!rules || !draft) throw new UserError("This kind of request can't be saved as a rule.");
    const rule = rules.add(thread.projectId, draft);
    this.autoApproved.set(itemKey(threadId, itemId), describeRule(rule));
    await this.respond(threadId, itemId, { kind: "approval", decision: "approve" });
    return rule;
  }

  private async respond(
    threadId: string,
    itemId: string,
    response: Parameters<ProviderSession["respondToRequest"]>[1],
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || !this.pendingRequests.get(threadId)?.has(itemId)) {
      throw new UserError("That request is no longer pending.");
    }
    (await session).respondToRequest(itemId, response);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((threadId) => this.closeSession(threadId)));
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  private ensureSession(thread: Thread): Promise<ProviderSession> {
    const existing = this.sessions.get(thread.id);
    if (existing) return existing;
    const adapter = this.providers[thread.provider];
    if (!adapter) return Promise.reject(new Error(`Unknown agent: ${thread.provider}`));
    const controller = new AbortController();
    const generation = ++this.generation;
    this.generations.set(thread.id, generation);
    const setup = this.setups.get(thread.id) ?? Promise.resolve();
    const toolServers = this.extras.toolServers ?? (async () => []);
    const opening = Promise.all([setup, toolServers().catch(() => [])]).then(([, mcpServers]) =>
      adapter.openSession({
        cwd: thread.cwd,
        runtimeMode: thread.runtimeMode,
        model: thread.model,
        resumeId: thread.providerSessionId,
        mcpServers,
        env: this.threadEnv(thread),
        signal: controller.signal,
        emit: (event) => {
          if (this.generations.get(thread.id) === generation) this.onAdapterEvent(thread.id, event);
        },
      }),
    );
    this.sessions.set(thread.id, opening);
    this.opening.set(thread.id, controller);
    this.sessionCost.delete(thread.id);
    opening.then(
      () => {
        if (this.opening.get(thread.id) === controller) this.opening.delete(thread.id);
      },
      () => {
        if (this.opening.get(thread.id) === controller) this.opening.delete(thread.id);
        if (this.sessions.get(thread.id) === opening) this.sessions.delete(thread.id);
      },
    );
    return opening;
  }

  private async closeSession(threadId: string): Promise<void> {
    this.clearIdleTimer(threadId);
    // From here on, anything the old session says is about a session we no longer have.
    this.generations.delete(threadId);
    this.unsavedSessionIds.delete(threadId);
    this.freshSessions.delete(threadId);
    this.opening.get(threadId)?.abort();
    this.opening.delete(threadId);
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    this.activeTurns.delete(threadId);
    this.pendingRequests.delete(threadId);
    if (session) await (await session.catch(() => null))?.close();
  }

  private clearIdleTimer(threadId: string): void {
    const timer = this.idleTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(threadId);
  }

  // ─── Provider events ───────────────────────────────────────────────────────

  private onAdapterEvent(threadId: string, event: AdapterEvent): void {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    switch (event.type) {
      case "session.ready": {
        if (event.resumed === false) this.freshSessions.add(threadId);
        // A prewarmed session has no history yet; only remember it for resuming
        // once a turn runs in it.
        const save =
          this.activeTurns.has(threadId) || thread.providerSessionId === event.providerSessionId;
        if (!save) this.unsavedSessionIds.set(threadId, event.providerSessionId);
        const patch: Partial<Thread> = {};
        if (save && thread.providerSessionId !== event.providerSessionId) {
          patch.providerSessionId = event.providerSessionId;
        }
        if (event.model && thread.model !== event.model) patch.model = event.model;
        if (Object.keys(patch).length > 0) this.store.commit([this.threadPatch(threadId, patch)]);
        return;
      }
      case "item":
        this.onItem(thread, event.id, event.body, event.final);
        return;
      case "turn.completed":
        this.completeTurn(threadId, event);
        return;
      case "session.exited":
        this.sessions.delete(threadId);
        this.pendingRequests.delete(threadId);
        if (this.activeTurns.has(threadId)) {
          this.completeTurn(threadId, {
            type: "turn.completed",
            status: "failed",
            usage: null,
            costUsd: null,
            error: event.error ?? "The agent process exited.",
          });
        }
        return;
    }
  }

  private onItem(thread: Thread, itemId: string, body: ItemBody, final: boolean): void {
    const item = this.toItem(thread.id, itemId, body);
    const key = itemKey(thread.id, itemId);
    if (!final) {
      let live = this.liveItems.get(thread.id);
      if (!live) {
        live = new Map();
        this.liveItems.set(thread.id, live);
      }
      live.set(itemId, item);
      if (!this.liveTimers.has(key)) {
        this.liveTimers.set(
          key,
          setTimeout(() => {
            this.liveTimers.delete(key);
            const latest = this.liveItems.get(thread.id)?.get(itemId);
            if (latest) this.onLive(latest);
          }, LIVE_PUSH_INTERVAL_MS),
        );
      }
      return;
    }

    const timer = this.liveTimers.get(key);
    if (timer) clearTimeout(timer);
    this.liveTimers.delete(key);
    this.liveItems.get(thread.id)?.delete(itemId);

    if (body.kind === "approval") {
      if (body.status === "pending") {
        const rule = this.extras.rules?.match(thread.projectId, body);
        if (rule) {
          // A saved rule covers it: answer without bothering the user (no
          // "needs input", no notification). The settled item says why.
          this.autoApproved.set(key, rule);
          void this.sessions
            .get(thread.id)
            ?.then((session) =>
              session.respondToRequest(itemId, { kind: "approval", decision: "approve" }),
            )
            .catch(() => undefined);
          return;
        }
      } else {
        const rule = this.autoApproved.get(key);
        if (rule) {
          this.autoApproved.delete(key);
          (item as ItemOf<"approval">).reason = `Allowed by your rule for ${rule} in this project.`;
        }
      }
    }

    const events: EventBody[] = [{ type: "item.upserted", item }];
    if (body.kind === "approval" || body.kind === "question") {
      let pending = this.pendingRequests.get(thread.id);
      if (!pending) {
        pending = new Set();
        this.pendingRequests.set(thread.id, pending);
      }
      if (body.status === "pending") pending.add(itemId);
      else pending.delete(itemId);
      const status =
        pending.size > 0 ? "needs-input" : this.activeTurns.has(thread.id) ? "running" : "idle";
      if (status !== thread.status) events.push(this.threadPatch(thread.id, { status }));
    }
    this.store.commit(events);
  }

  private completeTurn(
    threadId: string,
    event: Extract<AdapterEvent, { type: "turn.completed" }>,
  ): void {
    const turnId = this.activeTurns.get(threadId);
    this.activeTurns.delete(threadId);
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const events: EventBody[] = [];

    // Anything still streaming is as complete as it will get.
    const live = this.liveItems.get(threadId);
    for (const item of live?.values() ?? []) {
      const timer = this.liveTimers.get(itemKey(threadId, item.id));
      if (timer) clearTimeout(timer);
      this.liveTimers.delete(itemKey(threadId, item.id));
      const settled = finalizeLive(item);
      if (settled) events.push({ type: "item.upserted", item: settled });
    }
    this.liveItems.delete(threadId);

    // Requests left open by an ended turn can no longer be answered.
    for (const itemId of this.pendingRequests.get(threadId) ?? []) {
      const item = this.store.getItem(threadId, itemId);
      if (item && (item.kind === "approval" || item.kind === "question")) {
        events.push({ type: "item.upserted", item: { ...item, status: "cancelled" } });
      }
    }
    this.pendingRequests.delete(threadId);

    if (event.status === "failed" && event.error) {
      const reason = classifySetup(event.error);
      events.push({
        type: "item.upserted",
        item: this.toItem(
          threadId,
          `error:${turnId ?? newId()}`,
          {
            kind: "error",
            message: event.error,
            // Fixable outside the task (sign in, update): the UI offers the fix.
            setup: reason
              ? {
                  provider: thread.provider,
                  reason,
                  canSignIn: this.extras.canSignIn?.(thread.provider) ?? false,
                }
              : null,
          },
          turnId,
        ),
      });
    }
    const turn = turnId ? this.store.getTurn(turnId) : null;
    if (turn) {
      events.push({
        type: "turn.updated",
        turn: {
          ...turn,
          status: event.status,
          completedAt: Date.now(),
          usage: event.usage,
          error: event.error,
        },
      });
    }
    // If the prompt reached the agent, its session now holds the whole thread so far.
    const reached = turnId ? this.delivered.delete(turnId) : false;
    events.push(
      this.threadPatch(threadId, {
        status: event.status === "failed" ? "error" : "idle",
        costUsd: this.accumulateCost(thread, event.costUsd),
        ...(reached
          ? { agentSessions: this.agentSessions(this.requireThread(threadId), this.order) }
          : {}),
      }),
    );
    this.store.commit(events);
    if (turnId && turn?.checkpoint) this.checkpointAfter(threadId, turnId);

    this.scheduleIdleClose(threadId);
    // Let the adapter finish wrapping up the turn before it gets the next one.
    setTimeout(() => this.drainQueue(threadId, event.status), 0);
  }

  private scheduleIdleClose(threadId: string): void {
    this.clearIdleTimer(threadId);
    this.idleTimers.set(
      threadId,
      setTimeout(() => {
        if (!this.activeTurns.has(threadId)) void this.closeSession(threadId);
      }, SESSION_IDLE_MS),
    );
  }

  /**
   * Providers report a running total per session, which restarts when a
   * session is reopened and can read zero on an aborted turn. Add only what
   * this turn spent to the thread's lifetime total. (Observed with Claude Code
   * 2.1.x: a resumed session's total starts from zero.)
   */
  private accumulateCost(thread: Thread, reported: number | null): number | null {
    if (reported === null || reported <= 0) return thread.costUsd;
    const last = this.sessionCost.get(thread.id) ?? 0;
    const spent = reported >= last ? reported - last : reported;
    this.sessionCost.set(thread.id, reported);
    return (thread.costUsd ?? 0) + spent;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private requireThread(threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new UserError("Thread not found.");
    return thread;
  }

  private threadPatch(threadId: string, patch: Partial<Thread>): EventBody {
    const thread = this.requireThread(threadId);
    return { type: "thread.updated", thread: { ...thread, ...patch, updatedAt: Date.now() } };
  }

  /** Attach stable ordering metadata, fixed the first time an item is seen. */
  /** `turnId` names the turn when it has already ended (its error, say). */
  private toItem(threadId: string, itemId: string, body: ItemBody, turnId?: string | null): Item {
    const key = itemKey(threadId, itemId);
    let meta = this.itemMeta.get(key);
    if (!meta) {
      const stored = this.store.getItem(threadId, itemId);
      meta = stored
        ? { order: stored.order, createdAt: stored.createdAt, turnId: stored.turnId }
        : {
            order: ++this.order,
            createdAt: Date.now(),
            turnId: turnId ?? this.activeTurns.get(threadId) ?? null,
          };
      this.itemMeta.set(key, meta);
    }
    return { id: itemId, threadId, ...meta, ...body } as Item;
  }
}

function itemKey(threadId: string, itemId: string): string {
  return `${threadId}\u0000${itemId}`;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || DEFAULT_TITLE;
}

function finalizeLive(item: Item): Item | null {
  if (item.kind === "assistant_message" || item.kind === "reasoning") {
    return item.text.trim() ? { ...item, streaming: false } : null;
  }
  if (item.kind === "tool_call" && item.status === "running") return { ...item, status: "failed" };
  return item;
}

function settleOnRestart(item: Item): Item | null {
  if ((item.kind === "approval" || item.kind === "question") && item.status === "pending") {
    return { ...item, status: "cancelled" };
  }
  if ((item.kind === "assistant_message" || item.kind === "reasoning") && item.streaming) {
    return { ...item, streaming: false };
  }
  if (item.kind === "tool_call" && item.status === "running") return { ...item, status: "failed" };
  return null;
}
