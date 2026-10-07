import type {
  DomainEvent,
  Item,
  ItemOf,
  Project,
  ProviderStatus,
  ShellSnapshot,
  Thread,
  ThreadSnapshot,
  Turn,
} from "@agentplane/contracts";
import { createStore, useStore } from "zustand";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type ThreadDetail = {
  /** Highest durable event seq reflected in this detail. */
  seq: number;
  turns: Turn[];
  items: Item[];
};

export type AppState = {
  connection: ConnectionState;
  shellSeq: number;
  projects: Project[];
  threads: Record<string, Thread>;
  details: Record<string, ThreadDetail>;
  /** The server's agent catalog, keyed by agent id. */
  agents: Record<string, ProviderStatus>;
  /** When the user last looked at each thread (for "finished since you looked"). */
  seen: Record<string, number>;
};

/**
 * All server state lives here, outside React. The WebSocket client writes to
 * it; components subscribe with `useApp(selector)`.
 */
export const appStore = createStore<AppState>(() => ({
  connection: "connecting",
  shellSeq: 0,
  projects: [],
  threads: {},
  details: {},
  agents: {},
  seen: readSeen(),
}));

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem("agentplane-seen") ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

export function markSeen(threadId: string): void {
  appStore.setState((state) => {
    const seen = { ...state.seen, [threadId]: Date.now() };
    try {
      localStorage.setItem("agentplane-seen", JSON.stringify(seen));
    } catch {
      // Storage unavailable: seen state just won't survive a reload.
    }
    return { seen };
  });
}

/** Pending approvals and questions across every thread, oldest thread first. */
export function waitingRequests(
  state: Pick<AppState, "threads" | "details">,
): Array<{ thread: Thread; request: ItemOf<"approval"> | ItemOf<"question"> }> {
  return Object.values(state.threads)
    .filter((thread) => thread.status === "needs-input")
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .flatMap((thread) =>
      (state.details[thread.id]?.items ?? [])
        .filter(
          (item): item is ItemOf<"approval"> | ItemOf<"question"> =>
            (item.kind === "approval" || item.kind === "question") && item.status === "pending",
        )
        .map((request) => ({ thread, request })),
    );
}

/** Threads that finished (or failed) since the user last opened them. */
export function unseenFinished(state: Pick<AppState, "threads" | "seen">): Thread[] {
  return Object.values(state.threads)
    .filter(
      (thread) =>
        (thread.status === "idle" || thread.status === "error") &&
        thread.updatedAt > (state.seen[thread.id] ?? 0) &&
        thread.updatedAt - thread.createdAt > 2_000,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}

export function setAgents(agents: ProviderStatus[]): void {
  appStore.setState({ agents: Object.fromEntries(agents.map((agent) => [agent.provider, agent])) });
}

/** Threads grouped by project in sidebar order: projects as added, newest thread first. */
export function threadsByProject(state: Pick<AppState, "threads">): Map<string, Thread[]> {
  const groups = new Map<string, Thread[]>();
  for (const thread of Object.values(state.threads).sort((a, b) => b.createdAt - a.createdAt)) {
    groups.set(thread.projectId, [...(groups.get(thread.projectId) ?? []), thread]);
  }
  return groups;
}

/** Every thread in the order the sidebar shows them. */
export function orderedThreads(state: Pick<AppState, "projects" | "threads">): Thread[] {
  const groups = threadsByProject(state);
  return state.projects.flatMap((project) => groups.get(project.id) ?? []);
}

/** An agent's display name; falls back to its id before the catalog loads. */
export function useAgentLabel(id: string): string {
  return useApp((state) => state.agents[id]?.label) ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function setConnection(connection: ConnectionState): void {
  appStore.setState({ connection });
}

export function setShell(snapshot: ShellSnapshot): void {
  appStore.setState({
    shellSeq: snapshot.seq,
    projects: snapshot.projects,
    threads: Object.fromEntries(snapshot.threads.map((thread) => [thread.id, thread])),
  });
}

export function setThreadDetail(snapshot: ThreadSnapshot): void {
  appStore.setState((state) => ({
    threads: { ...state.threads, [snapshot.thread.id]: snapshot.thread },
    details: {
      ...state.details,
      [snapshot.thread.id]: { seq: snapshot.seq, turns: snapshot.turns, items: snapshot.items },
    },
  }));
}

function upsertItem(items: Item[], item: Item): Item[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    const next = items.slice();
    next[index] = item;
    return next;
  }
  const next = [...items, item];
  // Items almost always arrive in order; only sort when one doesn't.
  const last = items.at(-1);
  if (last && last.order > item.order) next.sort((a, b) => a.order - b.order);
  return next;
}

/** Once a turn ends nothing in it is still streaming; drop what never got text. */
function settleStreaming(items: Item[], turnId: string): Item[] {
  return items.flatMap((item) => {
    if (item.turnId !== turnId) return [item];
    if ((item.kind === "assistant_message" || item.kind === "reasoning") && item.streaming) {
      return item.text.trim() ? [{ ...item, streaming: false }] : [];
    }
    return [item];
  });
}

function upsertTurn(turns: Turn[], turn: Turn): Turn[] {
  const index = turns.findIndex((existing) => existing.id === turn.id);
  if (index < 0) return [...turns, turn];
  const next = turns.slice();
  next[index] = turn;
  return next;
}

export function applyEvent(event: DomainEvent): void {
  appStore.setState((state) => {
    const patch: Partial<AppState> = {};
    if (event.seq > state.shellSeq) {
      patch.shellSeq = event.seq;
      switch (event.type) {
        case "project.created":
          patch.projects = [
            ...state.projects.filter((project) => project.id !== event.project.id),
            event.project,
          ];
          break;
        case "project.deleted":
          patch.projects = state.projects.filter((project) => project.id !== event.projectId);
          break;
        case "thread.created":
        case "thread.updated":
          patch.threads = { ...state.threads, [event.thread.id]: event.thread };
          break;
        case "thread.deleted": {
          const { [event.threadId]: _thread, ...threads } = state.threads;
          const { [event.threadId]: _detail, ...details } = state.details;
          patch.threads = threads;
          patch.details = details;
          break;
        }
        default:
          break;
      }
    }

    const threadId =
      event.type === "turn.updated"
        ? event.turn.threadId
        : event.type === "item.upserted"
          ? event.item.threadId
          : null;
    const detail = threadId ? state.details[threadId] : undefined;
    if (threadId && detail && event.seq > detail.seq) {
      const next: ThreadDetail =
        event.type === "turn.updated"
          ? {
              ...detail,
              seq: event.seq,
              turns: upsertTurn(detail.turns, event.turn),
              items:
                event.turn.status === "running"
                  ? detail.items
                  : settleStreaming(detail.items, event.turn.id),
            }
          : event.type === "item.upserted"
            ? { ...detail, seq: event.seq, items: upsertItem(detail.items, event.item) }
            : detail;
      patch.details = { ...(patch.details ?? state.details), [threadId]: next };
    }
    return patch;
  });
}

/** A streaming item snapshot; replaced by later pushes and the final event. */
export function applyLive(item: Item): void {
  appStore.setState((state) => {
    const detail = state.details[item.threadId];
    if (!detail) return {};
    return {
      details: {
        ...state.details,
        [item.threadId]: { ...detail, items: upsertItem(detail.items, item) },
      },
    };
  });
}
