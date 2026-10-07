import type {
  ApprovalDecision,
  ItemBody,
  McpServerConfig,
  ModelOption,
  Provider,
  RuntimeMode,
  TurnStatus,
  Usage,
} from "@agentplane/contracts";

/**
 * What adapters report. Items are always whole-entity snapshots, never deltas:
 * an adapter re-emits the full item each time it changes, with `final: false`
 * while it is still streaming. The orchestrator throttles the non-final ones
 * and persists the final one.
 */
export type AdapterEvent =
  | {
      type: "session.ready";
      providerSessionId: string;
      model: string | null;
      /** When a resume was asked for: whether the earlier session really came back. */
      resumed?: boolean;
    }
  | { type: "item"; id: string; body: ItemBody; final: boolean }
  | {
      type: "turn.completed";
      status: Exclude<TurnStatus, "running">;
      usage: Usage | null;
      /**
       * The running cost total the provider reports for this session, if any.
       * It may restart from zero on resume and read zero on aborted turns; the
       * orchestrator turns it into per-turn deltas.
       */
      costUsd: number | null;
      error: string | null;
    }
  | { type: "session.exited"; error: string | null };

export type OpenSessionOptions = {
  cwd: string;
  runtimeMode: RuntimeMode;
  model: string | null;
  /** Provider-side id of a previous session to resume. */
  resumeId: string | null;
  /** Aborted if the user gives up while the session is still starting. */
  signal?: AbortSignal;
  /** Extra environment for the agent (e.g. PORT for this thread's port range). */
  env?: Record<string, string>;
  /** Remote MCP servers to give the agent (e.g. Composio tools). */
  mcpServers?: McpServerConfig[];
  emit: (event: AdapterEvent) => void;
};

/**
 * A live connection to one provider conversation. One turn runs at a time;
 * approvals and questions are surfaced as items and answered through
 * `respondToRequest`.
 */
export interface ProviderSession {
  startTurn(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respondToRequest(itemId: string, response: RequestResponse): void;
  setRuntimeMode(mode: RuntimeMode): Promise<void>;
  close(): Promise<void>;
  /**
   * Add earlier conversation to the agent's history natively (Codex). False
   * when unsupported; the history then goes in front of the next message.
   */
  injectHistory?(entries: Array<{ role: "user" | "assistant"; text: string }>): Promise<boolean>;
}

export type RequestResponse =
  | { kind: "approval"; decision: ApprovalDecision }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "cancel" };

export interface ProviderAdapter {
  readonly provider: Provider;
  openSession(options: OpenSessionOptions): Promise<ProviderSession>;
  /** Ask the agent which models it can run. */
  listModels?(): Promise<ModelOption[]>;
}
