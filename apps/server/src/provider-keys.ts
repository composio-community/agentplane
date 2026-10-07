import type { ProviderKeysStatus } from "@agentplane/contracts";
import { UserError } from "./orchestrator.ts";
import type { SettingsStore } from "./settings.ts";
import { errorMessage } from "./util.ts";

export type ProviderKeys = { openrouter: string | null };

const preview = (key: string) => `${key.slice(0, 8)}…${key.slice(-4)}`;

/**
 * Model provider keys (OpenRouter) the user entered, so agents that can use
 * them run without their own sign-in. Stored owner-only in settings.json and
 * handed to agents in their environment, never on a command line. A key
 * already exported in the user's shell counts too.
 */
export class ProviderKeyStore {
  constructor(
    private readonly settings: SettingsStore,
    /** Agents that run on a key, for the status line. */
    private readonly agentsUsing: (keys: ProviderKeys) => string[],
    /** Called after a change, so agent statuses and model lists refresh. */
    private readonly onChange: () => void,
    private readonly check: (key: string) => Promise<void> = checkOpenRouterKey,
  ) {}

  /** Keys for agents: Settings first, then the server's environment (or the repo's .env). */
  async keys(): Promise<ProviderKeys> {
    const saved = this.settings.get().keys.openrouter;
    return { openrouter: saved ?? process.env.OPENROUTER_API_KEY ?? null };
  }

  async status(): Promise<ProviderKeysStatus> {
    const saved = this.settings.get().keys.openrouter;
    const keys = await this.keys();
    return {
      openrouter: {
        configured: keys.openrouter !== null,
        source: saved ? "settings" : keys.openrouter ? "env" : null,
        preview: keys.openrouter ? preview(keys.openrouter) : null,
        agents: keys.openrouter ? this.agentsUsing(keys) : [],
      },
    };
  }

  async configure(params: { openrouter: string | null }): Promise<ProviderKeysStatus> {
    const key = params.openrouter?.trim() || null;
    if (key) await this.check(key);
    this.settings.update((settings) => ({
      ...settings,
      keys: { ...settings.keys, openrouter: key },
    }));
    this.onChange();
    return this.status();
  }
}

/** OpenRouter answers GET /key for a valid key (no tokens spent). */
async function checkOpenRouterKey(key: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new UserError(`Couldn't reach OpenRouter to check the key: ${errorMessage(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UserError("OpenRouter didn't accept that key.");
  }
  if (!response.ok) throw new UserError(`OpenRouter answered ${response.status}; try again.`);
}
