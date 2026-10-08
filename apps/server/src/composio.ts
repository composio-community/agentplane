import type {
  Automation,
  ComposioStatus,
  McpServerConfig,
  MethodParams,
  Thread,
  TriggerToolkit,
  TriggerType,
} from "@agentplane/contracts";
import { Composio } from "@composio/core";
import type { Orchestrator } from "./orchestrator.ts";
import { UserError } from "./orchestrator.ts";
import type { SettingsStore } from "./settings.ts";
import { errorMessage, newId, truncate, withTimeout } from "./util.ts";

/** A trigger event, normalized from Composio's payload. */
export type TriggerEvent = {
  eventId: string;
  triggerId: string | null;
  triggerSlug: string;
  toolkit: string;
  payload: Record<string, unknown>;
};

/**
 * The slice of Composio we use, so the rest of the app (and tests) don't
 * depend on the SDK's shapes.
 */
export interface ComposioApi {
  verify(): Promise<void>;
  /** Reuse a Tool Router session (or make one) and return its MCP endpoint. */
  mcpSession(
    userId: string,
    sessionId: string | null,
  ): Promise<{ sessionId: string; url: string; headers: Record<string, string> }>;
  connect(
    userId: string,
    sessionId: string | null,
    toolkit: string,
  ): Promise<{ connected: boolean; url: string | null }>;
  triggerTypes(toolkit: string): Promise<TriggerType[]>;
  triggerType(slug: string): Promise<TriggerType>;
  /** Apps that have at least one trigger. */
  toolkits(): Promise<TriggerToolkit[]>;
  /** Whether the user has an active connection to the app. */
  isConnected(userId: string, toolkit: string): Promise<boolean>;
  createTrigger(userId: string, slug: string, config: Record<string, unknown>): Promise<string>;
  setTriggerEnabled(triggerId: string, enabled: boolean): Promise<void>;
  deleteTrigger(triggerId: string): Promise<void>;
  /** Stream trigger events over Composio's realtime channel; no public URL needed. */
  subscribe(
    userId: string,
    onEvent: (event: TriggerEvent) => void,
    onError: (error: string) => void,
  ): Promise<() => Promise<void>>;
}

export function sdkComposioApi(apiKey: string): ComposioApi {
  // User keys (uak_…) go in a different header than project keys.
  const composio = apiKey.startsWith("uak_")
    ? new Composio({ apiKey: null, userApiKey: apiKey } as ConstructorParameters<
        typeof Composio
      >[0])
    : new Composio({ apiKey });
  return {
    async verify() {
      await composio.triggers.listTypes({ limit: 1 });
    },
    async mcpSession(userId, sessionId) {
      const session = sessionId
        ? await composio.sessions.use(sessionId, { mcp: true }).catch(() => null)
        : null;
      const active =
        session ?? (await composio.create(userId, { mcp: true, manageConnections: true }));
      return {
        sessionId: active.sessionId,
        url: active.mcp.url,
        headers: active.mcp.headers ?? {},
      };
    },
    async connect(userId, sessionId, toolkit) {
      const session = sessionId
        ? await composio.sessions.use(sessionId, { mcp: true }).catch(() => null)
        : null;
      const active =
        session ?? (await composio.create(userId, { mcp: true, manageConnections: true }));
      const { connectedAccounts } = {
        connectedAccounts: await composio.connectedAccounts.list({
          userIds: [userId],
          toolkitSlugs: [toolkit],
        }),
      };
      const items = (connectedAccounts as { items?: Array<{ status?: string }> }).items ?? [];
      if (items.some((account) => account.status === "ACTIVE"))
        return { connected: true, url: null };
      const request = await active.authorize(toolkit);
      return { connected: false, url: request.redirectUrl ?? null };
    },
    async triggerTypes(toolkit) {
      const response = await composio.triggers.listTypes({ toolkits: [toolkit], limit: 100 });
      const items = (response as { items?: Array<Record<string, unknown>> }).items ?? [];
      return items.map(toTriggerType);
    },
    async triggerType(slug) {
      return toTriggerType((await composio.triggers.getType(slug)) as Record<string, unknown>);
    },
    async toolkits() {
      const response = (await composio.toolkits.get({ limit: 1000 } as never)) as unknown;
      const items = (
        Array.isArray(response) ? response : ((response as { items?: unknown[] }).items ?? [])
      ) as Array<{ slug?: string; name?: string; meta?: Record<string, unknown> }>;
      return items
        .map((item) => ({
          slug: String(item.slug ?? ""),
          name: String(item.name ?? item.slug ?? ""),
          logo: typeof item.meta?.logo === "string" ? item.meta.logo : null,
          triggers: Number(item.meta?.triggersCount ?? item.meta?.triggers_count ?? 0),
        }))
        .filter((toolkit) => toolkit.slug && toolkit.triggers > 0)
        .sort((a, b) => b.triggers - a.triggers || a.name.localeCompare(b.name));
    },
    async isConnected(userId, toolkit) {
      const accounts = (await composio.connectedAccounts.list({
        userIds: [userId],
        toolkitSlugs: [toolkit],
      })) as { items?: Array<{ status?: string }> };
      return (accounts.items ?? []).some((account) => account.status === "ACTIVE");
    },
    async createTrigger(userId, slug, config) {
      const created = await composio.triggers.create(userId, slug, { triggerConfig: config });
      return String((created as { triggerId?: string }).triggerId ?? "");
    },
    async setTriggerEnabled(triggerId, enabled) {
      if (enabled) await composio.triggers.enable(triggerId);
      else await composio.triggers.disable(triggerId);
    },
    async deleteTrigger(triggerId) {
      await composio.triggers.delete(triggerId);
    },
    async subscribe(userId, onEvent, onError) {
      await composio.triggers.subscribe(
        (event) => {
          const metadata = (event.metadata ?? {}) as { id?: string };
          onEvent({
            eventId: event.id,
            triggerId: metadata.id ?? null,
            triggerSlug: event.triggerSlug,
            toolkit: event.toolkitSlug,
            payload: (event.payload ?? event.originalPayload ?? {}) as Record<string, unknown>,
          });
        },
        { userId },
        (error) => onError(JSON.stringify(error)),
      );
      // The SDK hides its Pusher client; when it's reachable, log drops and
      // reconnects (events sent while it's disconnected are not redelivered).
      const pusher = (
        composio.triggers as unknown as {
          pusherService?: {
            pusherClient?: {
              connection?: { bind: (event: string, fn: (s: unknown) => void) => void };
            };
          };
        }
      ).pusherService?.pusherClient;
      pusher?.connection?.bind("state_change", (states) => {
        const { previous, current } = states as { previous: string; current: string };
        if (current !== "connected" || previous !== "connecting") {
          console.log(`[composio] trigger stream ${previous} → ${current}`);
        }
      });
      return () => composio.triggers.unsubscribe();
    },
  };
}

function toTriggerType(item: Record<string, unknown>): TriggerType {
  return {
    slug: String(item.slug ?? ""),
    name: String(item.name ?? item.slug ?? ""),
    description: String(item.description ?? ""),
    instructions: String(item.instructions ?? ""),
    config: item.config ?? null,
    payload: item.payload ?? null,
  };
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  examples?: unknown[];
  default?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  title?: string;
};

/**
 * A realistic event from a payload schema: each field's own example (or
 * default, or first allowed value), so "Test" shows the agent what a real
 * event looks like.
 */
export function samplePayload(schema: unknown, depth = 0): unknown {
  const node = (schema ?? {}) as JsonSchema;
  if (node.examples?.length) return node.examples[0];
  if (node.default !== undefined && node.default !== "") return node.default;
  if (node.enum?.length) return node.enum[0];
  const variant = node.anyOf?.find((option) => option.type !== "null");
  if (variant) return samplePayload(variant, depth);
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
  if (depth > 4) return null;
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(node.properties ?? {}).map(([key, child]) => [
          key,
          samplePayload(child, depth + 1),
        ]),
      );
    case "array":
      return node.items ? [samplePayload(node.items, depth + 1)] : [];
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "string":
      return node.title ? `Sample ${node.title.toLowerCase()}` : "sample";
    default:
      return node.properties ? samplePayload({ ...node, type: "object" }, depth) : null;
  }
}

/** Fill {{payload}}, {{payload.a.b}}, {{toolkit}}, {{trigger}} in a prompt template. */
export function renderPrompt(template: string, event: TriggerEvent): string {
  const json = truncate(JSON.stringify(event.payload, null, 2), 8_000);
  const rendered = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    if (key === "payload") return json;
    if (key === "toolkit") return event.toolkit;
    if (key === "trigger") return event.triggerSlug;
    if (key.startsWith("payload.")) {
      let value: unknown = event.payload;
      for (const part of key.slice("payload.".length).split(".")) {
        value = (value as Record<string, unknown> | null | undefined)?.[part];
      }
      return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    }
    return "";
  });
  return template.includes("{{payload")
    ? rendered
    : `${rendered}\n\nEvent:\n\`\`\`json\n${json}\n\`\`\``;
}

/** A short title for a thread an event started. */
function eventTitle(automation: Automation, event: TriggerEvent): string {
  const payload = event.payload;
  const hint = ["title", "name", "subject", "summary", "message"]
    .map((key) => payload[key])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const title = hint ? `${automation.name}: ${hint}` : automation.name;
  return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}

/**
 * Composio inside the control plane: an MCP endpoint every agent gets, and
 * trigger events that start threads.
 */
export class ComposioService {
  private api: ComposioApi | null = null;
  private mcp: Promise<McpServerConfig> | null = null;
  private unsubscribe: (() => Promise<void>) | null = null;
  private listening = false;
  private lastError: string | null = null;
  private readonly seenEvents = new Set<string>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly orchestrator: Orchestrator,
    private readonly makeApi: (apiKey: string) => ComposioApi = sdkComposioApi,
  ) {}

  private key(): { key: string; source: "settings" | "env" } | null {
    const saved = this.settings.get().composio.apiKey;
    if (saved) return { key: saved, source: "settings" };
    const env = process.env.COMPOSIO_API_KEY;
    return env ? { key: env, source: "env" } : null;
  }

  private client(): ComposioApi {
    const key = this.key();
    if (!key) throw new UserError("Add a Composio API key in Settings first.");
    this.api ??= this.makeApi(key.key);
    return this.api;
  }

  status(): ComposioStatus {
    const key = this.key();
    return {
      configured: key !== null,
      keySource: key?.source ?? null,
      keyPreview: key ? `${key.key.slice(0, 4)}…${key.key.slice(-4)}` : null,
      toolsEnabled: this.settings.get().composio.toolsEnabled,
      listening: this.listening,
      error: this.lastError,
    };
  }

  async start(): Promise<void> {
    await this.syncSubscription();
  }

  async stop(): Promise<void> {
    await this.unsubscribe?.().catch(() => undefined);
    this.unsubscribe = null;
    this.listening = false;
  }

  async configure(params: MethodParams<"composio.configure">): Promise<ComposioStatus> {
    if (params.apiKey !== undefined) {
      if (params.apiKey) {
        const candidate = this.makeApi(params.apiKey.trim());
        try {
          await candidate.verify();
        } catch (error) {
          throw new UserError(`Composio didn't accept that key: ${composioMessage(error)}`);
        }
      }
      await this.stop();
      this.api = null;
      this.mcp = null;
      this.settings.update((settings) => ({
        ...settings,
        composio: { ...settings.composio, apiKey: params.apiKey?.trim() || null, sessionId: null },
      }));
    }
    if (params.toolsEnabled !== undefined) {
      this.settings.update((settings) => ({
        ...settings,
        composio: { ...settings.composio, toolsEnabled: params.toolsEnabled as boolean },
      }));
    }
    this.lastError = null;
    await this.syncSubscription();
    return this.status();
  }

  /**
   * MCP servers to hand every new agent session. Empty when Composio isn't
   * set up or tools are off; never blocks a session on Composio being down.
   */
  async toolServers(): Promise<McpServerConfig[]> {
    const { toolsEnabled } = this.settings.get().composio;
    if (!toolsEnabled || !this.key()) return [];
    this.mcp ??= (async () => {
      const { userId, sessionId } = this.settings.get().composio;
      const session = await this.client().mcpSession(userId, sessionId);
      if (session.sessionId !== sessionId) {
        this.settings.update((settings) => ({
          ...settings,
          composio: { ...settings.composio, sessionId: session.sessionId },
        }));
      }
      return { name: "composio", url: session.url, headers: session.headers };
    })();
    try {
      return [await withTimeout(this.mcp, 8_000)];
    } catch (error) {
      this.mcp = null;
      this.lastError = `Couldn't reach Composio for tools: ${errorMessage(error)}`;
      return [];
    }
  }

  connect(toolkit: string) {
    const { userId, sessionId } = this.settings.get().composio;
    return this.client().connect(userId, sessionId, toolkit);
  }

  triggerTypes(toolkit: string): Promise<TriggerType[]> {
    return this.client().triggerTypes(toolkit);
  }

  private toolkitList: { at: number; list: Promise<TriggerToolkit[]> } | null = null;

  /** Apps with triggers; the catalog changes slowly, so it's kept for an hour. */
  toolkits(): Promise<TriggerToolkit[]> {
    if (!this.toolkitList || Date.now() - this.toolkitList.at > 60 * 60 * 1000) {
      const list = this.client().toolkits();
      list.catch(() => {
        this.toolkitList = null;
      });
      this.toolkitList = { at: Date.now(), list };
    }
    return this.toolkitList.list;
  }

  async connection(toolkit: string): Promise<{ connected: boolean }> {
    const { userId } = this.settings.get().composio;
    return { connected: await this.client().isConnected(userId, toolkit) };
  }

  // ─── Automations ───────────────────────────────────────────────────────────

  listAutomations(): Automation[] {
    return this.settings.get().automations;
  }

  async createAutomation(params: MethodParams<"automations.create">): Promise<Automation> {
    const { userId } = this.settings.get().composio;
    if (!(await this.client().isConnected(userId, params.toolkit))) {
      throw new UserError(`Connect ${params.toolkit} first: its trigger runs on your account.`);
    }
    let triggerId: string;
    try {
      triggerId = await this.client().createTrigger(
        userId,
        params.triggerSlug,
        params.triggerConfig,
      );
    } catch (error) {
      throw new UserError(
        `Couldn't create the ${params.triggerSlug} trigger. Is ${params.toolkit} connected? (${errorMessage(error)})`,
      );
    }
    const automation: Automation = {
      ...params,
      model: params.model ?? null,
      id: newId(),
      triggerId,
      enabled: true,
      createdAt: Date.now(),
      lastFiredAt: null,
      firedCount: 0,
    };
    this.settings.update((settings) => ({
      ...settings,
      automations: [...settings.automations, automation],
    }));
    await this.syncSubscription();
    return automation;
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation> {
    const automation = this.requireAutomation(id);
    if (automation.triggerId) await this.client().setTriggerEnabled(automation.triggerId, enabled);
    const updated = this.patch(id, { enabled });
    await this.syncSubscription();
    return updated;
  }

  async deleteAutomation(id: string): Promise<void> {
    const automation = this.requireAutomation(id);
    if (automation.triggerId) {
      await this.client()
        .deleteTrigger(automation.triggerId)
        .catch(() => undefined);
    }
    this.settings.update((settings) => ({
      ...settings,
      automations: settings.automations.filter((candidate) => candidate.id !== id),
    }));
    await this.syncSubscription();
  }

  /** Run an automation on a sample event (built from the trigger's own examples). */
  async test(id: string): Promise<Thread> {
    const automation = this.requireAutomation(id);
    const type = await this.client()
      .triggerType(automation.triggerSlug)
      .catch(() => null);
    const sample = samplePayload(type?.payload);
    return this.fire(automation, {
      eventId: `test-${newId()}`,
      triggerId: automation.triggerId,
      triggerSlug: automation.triggerSlug,
      toolkit: automation.toolkit,
      payload: {
        ...(sample && typeof sample === "object" ? (sample as Record<string, unknown>) : {}),
        _test: "Sample event from Agentplane's Test button; values are examples, not real.",
      },
    });
  }

  /** A trigger event arrived: start a thread for each automation it belongs to. */
  async handleEvent(event: TriggerEvent): Promise<void> {
    if (this.seenEvents.has(event.eventId)) return;
    this.seenEvents.add(event.eventId);
    if (this.seenEvents.size > 1_000) {
      const oldest = this.seenEvents.values().next().value;
      if (oldest) this.seenEvents.delete(oldest);
    }
    const matches = this.listAutomations().filter(
      (automation) =>
        automation.enabled &&
        (event.triggerId
          ? automation.triggerId === event.triggerId
          : automation.triggerSlug === event.triggerSlug),
    );
    for (const automation of matches) {
      await this.fire(automation, event).catch((error) => {
        this.lastError = `${automation.name} failed to start a thread: ${errorMessage(error)}`;
      });
    }
  }

  private async fire(automation: Automation, event: TriggerEvent): Promise<Thread> {
    const thread = await this.orchestrator.createThread(
      {
        projectId: automation.projectId,
        provider: automation.provider,
        runtimeMode: automation.runtimeMode,
        model: automation.model ?? null,
        worktree: automation.worktree,
      },
      {
        title: eventTitle(automation, event),
        origin: `${automation.toolkit} · ${automation.name}`,
      },
    );
    this.orchestrator.sendMessage(thread.id, renderPrompt(automation.prompt, event));
    this.patch(automation.id, { lastFiredAt: Date.now(), firedCount: automation.firedCount + 1 });
    return thread;
  }

  private requireAutomation(id: string): Automation {
    const automation = this.listAutomations().find((candidate) => candidate.id === id);
    if (!automation) throw new UserError("Automation not found.");
    return automation;
  }

  private patch(id: string, change: Partial<Automation>): Automation {
    const settings = this.settings.update((current) => ({
      ...current,
      automations: current.automations.map((automation) =>
        automation.id === id ? { ...automation, ...change } : automation,
      ),
    }));
    return settings.automations.find((automation) => automation.id === id) as Automation;
  }

  /** Listen for trigger events only while there's something to run. */
  private async syncSubscription(): Promise<void> {
    const wanted =
      this.key() !== null && this.listAutomations().some((automation) => automation.enabled);
    if (wanted === this.listening) return;
    if (!wanted) {
      await this.stop();
      return;
    }
    try {
      const { userId } = this.settings.get().composio;
      this.unsubscribe = await this.client().subscribe(
        userId,
        (event) => void this.handleEvent(event),
        (error) => {
          this.listening = false;
          this.lastError = `Lost the Composio trigger stream: ${error}`;
        },
      );
      this.listening = true;
    } catch (error) {
      this.lastError = `Couldn't listen for Composio triggers: ${errorMessage(error)}`;
    }
  }
}

/** Composio errors often wrap a JSON body; show just its message. */
function composioMessage(error: unknown): string {
  const text = errorMessage(error);
  const match = /"message"\s*:\s*"([^"]+)"/.exec(text);
  return match?.[1] ?? text;
}
