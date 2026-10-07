import type {
  AgentModels,
  DomainEvent,
  MethodName,
  MethodParams,
  MethodResult,
  ProviderStatus,
  ServerMessage,
  Thread,
} from "@agentplane/contracts";
import {
  applyEvent,
  applyLive,
  appStore,
  setAgents,
  setConnection,
  setShell,
  setThreadDetail,
} from "./store.ts";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Where terminal streams go; set once the terminal drawer's code has loaded. */
export type TerminalSink = {
  output: (terminalId: string, data: string) => void;
  exit: (terminalId: string, exitCode: number | null) => void;
  /** A new connection receives nothing until it attaches again. */
  reconnected: () => void;
};

let terminalSink: TerminalSink | null = null;

export function setTerminalSink(sink: TerminalSink): void {
  terminalSink = sink;
}

/**
 * The single connection to the local server. It owns reconnects: on every
 * (re)connect it refetches the shell and every thread the UI has open, so
 * nothing is missed while it was away.
 */
class ServerClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: string[] = [];
  private retry = 0;

  constructor() {
    this.connect();
  }

  private connect(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    setConnection("connecting");

    socket.addEventListener("open", () => {
      this.retry = 0;
      for (const message of this.queue.splice(0)) socket.send(message);
    });
    socket.addEventListener("message", (event) => {
      this.onMessage(JSON.parse(String(event.data)) as ServerMessage);
    });
    socket.addEventListener("close", () => {
      this.socket = null;
      setConnection("disconnected");
      for (const request of this.pending.values()) request.reject(new Error("Disconnected"));
      this.pending.clear();
      const delay = Math.min(10_000, 500 * 2 ** this.retry) * (0.75 + Math.random() * 0.5);
      this.retry += 1;
      setTimeout(() => this.connect(), delay);
    });
  }

  private onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        void this.resync();
        return;
      case "response": {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.ok) request.resolve(message.result);
        else request.reject(new Error(message.error));
        return;
      }
      case "event":
        notifyOnChange(message.event);
        applyEvent(message.event);
        return;
      case "live":
        applyLive(message.item);
        return;
      case "terminal.output":
        terminalSink?.output(message.terminalId, message.data);
        return;
      case "terminal.exit":
        terminalSink?.exit(message.terminalId, message.exitCode);
        return;
    }
  }

  private async resync(): Promise<void> {
    void agentStatuses();
    terminalSink?.reconnected();
    setShell(await this.request("shell.get", {}));
    const state = appStore.getState();
    const waiting = Object.values(state.threads)
      .filter((thread) => thread.status === "needs-input")
      .map((thread) => thread.id);
    const open = [...new Set([...Object.keys(state.details), ...waiting])];
    await Promise.all(
      open.map((threadId) =>
        this.request("thread.get", { threadId }).then(setThreadDetail, () => undefined),
      ),
    );
    setConnection("connected");
  }

  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const id = this.nextId++;
    const data = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
      else this.queue.push(data);
    });
  }
}

export const client = new ServerClient();

let agents: Promise<ProviderStatus[]> | null = null;

/** The agent catalog and what's installed. Cached for `use()`; installs rarely change. */
export function agentStatuses(): Promise<ProviderStatus[]> {
  agents ??= client.request("providers.status", {}).then((statuses) => {
    setAgents(statuses);
    return statuses;
  });
  agents.catch(() => {
    agents = null;
  });
  return agents;
}

/** Re-check installs and sign-ins (after the user signs an agent in). */
export function refreshAgentStatuses(): Promise<ProviderStatus[]> {
  agents = client.request("providers.status", { refresh: true }).then((statuses) => {
    setAgents(statuses);
    return statuses;
  });
  agents.catch(() => {
    agents = null;
  });
  return agents;
}

const models = new Map<string, Promise<AgentModels>>();

/** An agent's models (cached per agent for `use()`); `refresh` asks the agent again. */
export function agentModels(provider: string, refresh = false): Promise<AgentModels> {
  let pending = refresh ? undefined : models.get(provider);
  if (!pending) {
    pending = client.request("agents.models", { provider, refresh });
    pending.catch(() => models.delete(provider));
    models.set(provider, pending);
  }
  return pending;
}

/** Fetch a thread's timeline once; live events keep it current afterwards. */
export async function loadThread(threadId: string): Promise<void> {
  if (appStore.getState().details[threadId]) return;
  setThreadDetail(await client.request("thread.get", { threadId }));
}

// ─── Attention: notifications and the tab title ──────────────────────────────

function notifyOnChange(event: DomainEvent): void {
  if (event.type !== "thread.updated") return;
  const previous = appStore.getState().threads[event.thread.id];
  if (!previous || previous.status === event.thread.status) return;
  const thread = event.thread;
  // The inbox shows pending requests from every thread, so load them.
  if (thread.status === "needs-input") void loadThread(thread.id).catch(() => undefined);
  if (thread.status === "needs-input") notify(thread, "Needs your input");
  else if (previous.status === "running" && thread.status === "idle") notify(thread, "Finished");
  else if (thread.status === "error") notify(thread, "Stopped with an error");
}

function notify(thread: Thread, body: string): void {
  if (!document.hidden || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  const notification = new Notification(thread.title, { body, tag: thread.id });
  notification.onclick = () => {
    window.focus();
    history.pushState(null, "", `/t/${thread.id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  };
}

/** Ask once, from a user gesture, so "needs input" can reach a hidden tab. */
export function requestNotificationPermission(): void {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

appStore.subscribe((state) => {
  const waiting = Object.values(state.threads).filter((t) => t.status === "needs-input").length;
  document.title = waiting > 0 ? `(${waiting}) Agentplane` : "Agentplane";
});
