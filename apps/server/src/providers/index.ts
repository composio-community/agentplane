import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentModels,
  AgentProtocol,
  ProviderStatus,
  RuntimeMode,
} from "@agentplane/contracts";
import type { ServerConfig } from "../config.ts";
import type { ProviderKeys } from "../provider-keys.ts";
import { errorMessage } from "../util.ts";
import { type AcpAgentSpec, type AcpLaunch, acpAdapter } from "./acp.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { agentEnvironment, binaryVersion, which } from "./detect.ts";
import { piAdapter } from "./pi.ts";
import { AgentRegistry, availability, type RegistryAgent } from "./registry.ts";
import { AUTH_CHECKS, type AuthState, classifySetup, openTerminal } from "./setup.ts";
import type { ProviderAdapter } from "./types.ts";

type Probe = Omit<
  ProviderStatus,
  "provider" | "label" | "protocol" | "installHint" | "group" | "description" | "auth" | "canSignIn"
>;

export type AgentDefinition = {
  id: string;
  label: string;
  protocol: AgentProtocol;
  group: "featured" | "registry";
  installHint: string;
  description: string | null;
  adapter: ProviderAdapter;
  probe: () => Promise<Probe>;
  /** CLI to look for on PATH, and the args that make it sign in (null: no terminal sign-in). */
  binary: string | null;
  signInArgs: string[] | null;
  /** The environment that runs this agent on the user's model keys, or null if they can't. */
  keyEnv?: (keys: ProviderKeys) => Record<string, string> | null;
};

type LaunchContext = Parameters<AcpAgentSpec["launch"]>[0];

/** A featured ACP agent: its CLI on PATH if installed, else the ACP registry's build. */
type FeaturedAcp = Omit<AcpAgentSpec, "launch"> & {
  binary?: string;
  args?: (context: LaunchContext) => string[];
  registryId?: string;
  /** Adjust a registry launch (args, env) for this agent. */
  adjust?: (launch: AcpLaunch, context: LaunchContext) => AcpLaunch;
  /** Args that make the CLI sign in; [] means "just run it" (it asks on first start). */
  signInArgs?: string[];
  installHint: string;
  description: string;
  keyEnv?: AgentDefinition["keyEnv"];
  /**
   * Builds on PATH can predate ACP: if `--help` doesn't mention it, use the
   * registry's current build instead of failing.
   */
  checkPathSpeaksAcp?: boolean;
  /** Environment it always gets (both PATH and registry builds). */
  env?: Record<string, string>;
};

/**
 * The default for agents running on an OpenRouter key when the user hasn't
 * picked a model: Pi's own choice for OpenRouter (capable at agentic coding,
 * inexpensive), then fallbacks in case it's gone from the catalog.
 */
const OPENROUTER_DEFAULTS = ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2", "qwen/qwen3-coder"];

const openRouterEnv = (keys: ProviderKeys) =>
  keys.openrouter ? { OPENROUTER_API_KEY: keys.openrouter } : null;

/**
 * Grok only reaches other endpoints through model blocks in its config.toml,
 * so a key-only Grok gets its own profile (GROK_HOME) with OpenRouter models;
 * the user's ~/.grok is never touched. The key itself stays in the env.
 */
const GROK_OPENROUTER_MODELS: Array<[block: string, model: string]> = [
  ["grok-build", "x-ai/grok-build-0.1"],
  ["grok-4.3", "x-ai/grok-4.3"],
  ["kimi-k2.6", "moonshotai/kimi-k2.6"],
  ["gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite"],
];

function grokProfileConfig(): string {
  const blocks = GROK_OPENROUTER_MODELS.map(
    ([block, model]) =>
      `[model.${JSON.stringify(block)}]\nmodel = ${JSON.stringify(model)}\nbase_url = "https://openrouter.ai/api/v1"\nenv_key = "OPENROUTER_API_KEY"\n`,
  );
  return `# Written by Agentplane for running Grok on your OpenRouter key.\n[models]\ndefault = ${JSON.stringify(GROK_OPENROUTER_MODELS[0]?.[0])}\n\n${blocks.join("\n")}`;
}

/** Signed in to xAI (Grok's own login or key): then Grok runs as the user set it up. */
const grokSignedIn = () =>
  Boolean(process.env.XAI_API_KEY) || existsSync(join(homedir(), ".grok", "auth.json"));

const execFileAsync = promisify(execFile);

/** Registry agents we cover natively or as featured agents. */
const NOT_FROM_REGISTRY = new Set(["claude-acp", "codex-acp", "pi-acp"]);

/** Grok: full access skips its prompts; otherwise it asks and our policy decides. */
function grokArgs(mode: RuntimeMode): string[] {
  return mode === "full-access"
    ? ["agent", "--always-approve", "stdio"]
    : ["--permission-mode", "default", "agent", "stdio"];
}

function nativeAgent(options: {
  id: string;
  label: string;
  binary: string;
  signInArgs: string[];
  protocol: AgentProtocol;
  installHint: string;
  description: string;
  adapter: ProviderAdapter;
  keyEnv?: AgentDefinition["keyEnv"];
}): AgentDefinition {
  return {
    ...options,
    group: "featured",
    probe: async () => {
      const path = await which(options.binary);
      return {
        installed: path !== null,
        source: path ? "path" : null,
        note: null,
        path,
        version: path ? await binaryVersion(path, ["--version"]) : null,
      };
    },
  };
}

/**
 * Every agent we can drive, built once per server. Native adapters for Claude,
 * Codex and Pi; ACP for the rest, including anything in the ACP registry.
 */
export class AgentCatalog {
  readonly registry: AgentRegistry;
  readonly adapters: Record<string, ProviderAdapter> = {};
  private readonly definitions = new Map<string, AgentDefinition>();
  private cached: { at: number; statuses: Promise<ProviderStatus[]> } | null = null;
  private readonly modelCache = new Map<string, AgentModels>();
  private readonly modelFetches = new Map<string, Promise<AgentModels>>();

  /** A `$BROWSER` that prints the URL to stderr, where adapters pick up sign-in links. */
  private readonly printUrlHelper: string;
  /** GROK_HOME for running Grok on the user's OpenRouter key. */
  private readonly grokProfile: string;
  private readonly toolsDir: string;

  constructor(
    config: Pick<ServerConfig, "toolsDir">,
    /** The user's model provider keys (OpenRouter), for agents that can run on them. */
    private readonly keys: () => Promise<ProviderKeys> = async () => ({ openrouter: null }),
  ) {
    this.toolsDir = config.toolsDir;
    this.registry = new AgentRegistry(config.toolsDir);
    this.printUrlHelper = join(config.toolsDir, "print-sign-in-url.sh");
    mkdirSync(config.toolsDir, { recursive: true });
    writeFileSync(
      this.printUrlHelper,
      '#!/bin/sh\necho "Open the following link to sign in: $1" >&2\n',
      { mode: 0o755 },
    );
    this.grokProfile = join(config.toolsDir, "grok-openrouter");
    mkdirSync(this.grokProfile, { recursive: true });
    writeFileSync(join(this.grokProfile, "config.toml"), grokProfileConfig(), { mode: 0o600 });
    for (const definition of this.featured(config.toolsDir)) this.add(definition);
  }

  private add(definition: AgentDefinition): void {
    this.definitions.set(definition.id, definition);
    this.adapters[definition.id] = definition.adapter;
  }

  private featured(toolsDir: string): AgentDefinition[] {
    return [
      nativeAgent({
        id: "claude",
        label: "Claude Code",
        binary: "claude",
        protocol: "native",
        signInArgs: ["auth", "login"],
        installHint: "npm i -g @anthropic-ai/claude-code, then run `claude` to sign in",
        description: "Anthropic's coding agent, via the Claude Agent SDK.",
        adapter: claudeAdapter,
      }),
      nativeAgent({
        id: "codex",
        label: "Codex",
        binary: "codex",
        protocol: "native",
        signInArgs: ["login"],
        installHint: "npm i -g @openai/codex, then `codex login`",
        description: "OpenAI's coding agent, via `codex app-server`.",
        adapter: codexAdapter,
      }),
      this.acp({
        id: "antigravity",
        label: "Google Antigravity",
        registryId: "antigravity-acp",
        signInHint: "Open the sign-in link shown in the thread, then send your message again.",
        installHint: "Downloads Google's ACP server from dl.google.com on first use",
        description: "Google's coding agent (Gemini), via its ACP server.",
        clientFs: true,
        eagerAuthMethod: "oauth-personal",
        nativeModes: { supervised: "default", "auto-edit": "auto_edit", "full-access": "yolo" },
        adjust: (launch) => ({
          ...launch,
          env: {
            ...launch.env,
            ANTIGRAVITY_HARNESS_PATH: join(dirname(launch.command), "localharness_external"),
            PYTHONUNBUFFERED: "1",
            // Its own profile, so it never touches the user's ~/.gemini config;
            // credentials live in a file there instead of the keychain.
            GEMINI_HOME: join(this.toolsDir, "antigravity-profile"),
            AGY_ACP_FORCE_FILE_STORAGE: "1",
            // Sign-in links show up in the thread instead of a browser popping open.
            BROWSER: this.printUrlHelper,
          },
        }),
      }),
      this.acp({
        id: "cursor",
        signInArgs: ["login"],
        label: "Cursor",
        binary: "cursor-agent",
        args: () => ["acp"],
        registryId: "cursor",
        checkPathSpeaksAcp: true,
        signInHint:
          "Run `cursor-agent login` in a terminal. Older cursor-agent builds lack ACP: `cursor-agent update`.",
        installHint: "curl https://cursor.com/install -fsS | bash, then `cursor-agent login`",
        description: "Cursor's agent CLI.",
      }),
      nativeAgent({
        id: "pi",
        label: "Pi",
        binary: "pi",
        protocol: "rpc",
        signInArgs: [],
        installHint: "npm i -g @earendil-works/pi-coding-agent, then run `pi` and /login",
        description: "Minimal, extensible coding agent; any model provider.",
        adapter: piAdapter(toolsDir, async () => openRouterEnv(await this.keys()) ?? {}),
        keyEnv: openRouterEnv,
      }),
      this.acp({
        id: "grok",
        signInArgs: ["login"],
        label: "Grok",
        binary: "grok",
        args: ({ mode }) => grokArgs(mode),
        registryId: "grok-build",
        adjust: (launch, { mode }) => ({
          ...launch,
          // The registry runs `npx -y <pkg> agent stdio`; swap in mode-aware args.
          args: [
            ...launch.args.filter((arg) => arg !== "agent" && arg !== "stdio"),
            ...grokArgs(mode),
          ],
        }),
        signInHint: "Run `grok login` in a terminal, or add an OpenRouter key in Settings.",
        installHint: "npm i -g @xai-official/grok, then `grok login`",
        description: "xAI's coding agent.",
        keyEnv: (keys) =>
          keys.openrouter && !grokSignedIn()
            ? { OPENROUTER_API_KEY: keys.openrouter, GROK_HOME: this.grokProfile }
            : null,
        // Without this Grok's auto mode denies silently instead of asking.
        initializeMeta: { clientType: "extension" },
        cancelMeta: { cancelTrigger: "ctrl_c" },
        isTurnComplete: (method, params) =>
          method.endsWith("x.ai/session/prompt_complete") ||
          ((method.endsWith("x.ai/session_notification") ||
            method.endsWith("x.ai/session/update")) &&
            (params.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ===
              "turn_completed"),
      }),
      this.acp({
        id: "opencode",
        signInArgs: ["auth", "login"],
        label: "OpenCode",
        binary: "opencode",
        // Errors only go to stderr, which is how we learn why a turn ended silently.
        args: () => ["acp", "--print-logs", "--log-level", "ERROR"],
        registryId: "opencode",
        signInHint: "Run `opencode auth login` in a terminal.",
        installHint: "curl -fsSL https://opencode.ai/install | bash, then `opencode auth login`",
        description: "Open-source agent for any model provider.",
        // OpenCode allows every tool by default and so never asks; make it
        // ask, and the thread's permission mode answers.
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: { edit: "ask", bash: "ask", webfetch: "ask" },
          }),
        },
        keyEnv: openRouterEnv,
        // Its own default is a free OpenCode model that refuses other clients;
        // with OpenRouter models available, start on one of those instead.
        preferredDefault: (current, options) =>
          current?.id.startsWith("opencode/")
            ? (OPENROUTER_DEFAULTS.map((id) => `openrouter/${id}`).find((id) =>
                options.some((option) => option.id === id),
              ) ?? null)
            : null,
      }),
      this.acp({
        id: "gemini",
        label: "Gemini CLI",
        binary: "gemini",
        args: ({ model }) => ["--acp", ...(model ? ["--model", model] : [])],
        modelViaArgs: true,
        registryId: "gemini",
        signInHint:
          "Google no longer lets Gemini CLI use personal Google accounts: get a key at aistudio.google.com/apikey, set GEMINI_API_KEY, and choose “Use Gemini API key” under /auth in `gemini`. Or use Google Antigravity.",
        installHint: "npm i -g @google/gemini-cli, then run `gemini` to sign in",
        description: "Google's open-source CLI agent.",
        nativeModes: { supervised: "default", "auto-edit": "autoEdit", "full-access": "yolo" },
      }),
      this.acp({
        id: "copilot",
        label: "GitHub Copilot",
        binary: "copilot",
        args: () => ["--acp"],
        registryId: "github-copilot-cli",
        signInHint:
          "Sign in to GitHub with `gh auth login`, or run `npx -y @github/copilot login` in a terminal.",
        installHint: "npm i -g @github/copilot, then run `copilot` to sign in",
        description: "GitHub Copilot's coding agent CLI.",
      }),
      this.acp({
        id: "qwen",
        label: "Qwen Code",
        binary: "qwen",
        args: ({ model }) => ["--acp", ...(model ? ["--model", model] : [])],
        modelViaArgs: true,
        registryId: "qwen-code",
        signInHint: "Run `qwen` in a terminal to sign in, or add an OpenRouter key in Settings.",
        installHint: "npm i -g @qwen-code/qwen-code, then run `qwen` to sign in",
        description: "Alibaba's coding agent.",
        // Its own default is "auto" (a model decides what's safe); ours decide.
        nativeModes: { supervised: "default", "auto-edit": "auto-edit", "full-access": "yolo" },
        // OpenAI-compatible mode, pointed at OpenRouter; only when Qwen has no login of its own.
        keyEnv: (keys) =>
          keys.openrouter && !existsSync(join(homedir(), ".qwen", "oauth_creds.json"))
            ? {
                OPENAI_API_KEY: keys.openrouter,
                OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
                OPENAI_MODEL: "qwen/qwen3-coder",
              }
            : null,
      }),
      this.acp({
        id: "goose",
        signInArgs: ["configure"],
        label: "Goose",
        binary: "goose",
        args: () => ["acp"],
        registryId: "goose",
        signInHint: "Run `goose configure` in a terminal, or add an OpenRouter key in Settings.",
        installHint: "Install Goose from block.github.io/goose, then `goose configure`",
        description: "Block's open-source agent.",
        // Goose starts in "auto" (approves every tool). Ask for everything and
        // let the thread's mode answer, except full access.
        nativeModes: { supervised: "approve", "auto-edit": "approve", "full-access": "auto" },
        // The key always; a provider and model only when Goose has no config
        // of its own (env would override the user's choice).
        keyEnv: (keys) =>
          keys.openrouter
            ? {
                OPENROUTER_API_KEY: keys.openrouter,
                ...(existsSync(join(homedir(), ".config", "goose", "config.yaml"))
                  ? {}
                  : {
                      GOOSE_PROVIDER: "openrouter",
                      GOOSE_MODEL: OPENROUTER_DEFAULTS[0] ?? "moonshotai/kimi-k2.6",
                    }),
              }
            : null,
      }),
      this.acp({
        id: "devin",
        label: "Devin",
        binary: "devin",
        args: () => ["acp"],
        registryId: "devin",
        signInHint: "Run `devin` in a terminal to sign in.",
        installHint: "Downloads the Devin CLI on first use",
        description: "Cognition's coding agent.",
      }),
      this.acp({
        id: "amp",
        label: "Amp",
        registryId: "amp-acp",
        signInHint: "Set AMP_API_KEY, or run `amp login` in a terminal.",
        installHint: "Downloads the Amp ACP adapter on first use",
        description: "Sourcegraph's coding agent.",
      }),
      this.acp({
        id: "kimi",
        label: "Kimi CLI",
        registryId: "kimi",
        signInHint: "Run `kimi` in a terminal and /login.",
        installHint: "Downloads Kimi CLI on first use",
        description: "Moonshot AI's coding agent.",
      }),
    ];
  }

  private acp(featured: FeaturedAcp): AgentDefinition {
    const {
      binary,
      args,
      registryId,
      adjust,
      installHint,
      description,
      signInArgs,
      keyEnv,
      checkPathSpeaksAcp,
      env,
      ...spec
    } = featured;
    const registry = this.registry;
    const withKeys = async (launch: AcpLaunch): Promise<AcpLaunch> => {
      const extra = { ...env, ...keyEnv?.(await this.keys()) };
      return Object.keys(extra).length > 0
        ? { ...launch, env: { ...launch.env, ...extra } }
        : launch;
    };
    const usablePath = async () => {
      const path = binary ? await which(binary) : null;
      if (!path || !checkPathSpeaksAcp) return path;
      return (await this.speaksAcp(path)) ? path : null;
    };
    const launch = async (context: LaunchContext): Promise<AcpLaunch> => {
      const path = await usablePath();
      if (path) return withKeys({ command: path, args: args?.(context) ?? [] });
      const agent = registryId ? await registry.find(registryId) : null;
      if (agent) {
        const resolved = await registry.launch(agent, context.notify, {
          allowInstall: context.allowInstall ?? true,
        });
        return withKeys(adjust ? adjust(resolved, context) : resolved);
      }
      throw new Error(`${spec.label} isn't installed. ${installHint}`);
    };
    return {
      id: spec.id,
      label: spec.label,
      protocol: "acp",
      group: "featured",
      installHint,
      description,
      binary: binary ?? null,
      signInArgs: binary ? (signInArgs ?? []) : null,
      ...(keyEnv ? { keyEnv } : {}),
      adapter: acpAdapter({ ...spec, launch }),
      probe: async () => {
        const path = binary ? await which(binary) : null;
        if (path) {
          return {
            installed: true,
            source: "path",
            note: null,
            path,
            version: await binaryVersion(path, ["--version"]),
          };
        }
        const agent = registryId ? await registry.find(registryId) : null;
        if (!agent)
          return { installed: false, source: null, note: null, path: null, version: null };
        const { available, note } = await availability(agent);
        return {
          installed: available,
          source: "registry",
          note,
          path: null,
          version: agent.version,
        };
      },
    };
  }

  private readonly acpSupport = new Map<string, Promise<boolean>>();

  /** Whether a CLI lists an `acp` command in its help (asked once per binary). */
  private speaksAcp(path: string): Promise<boolean> {
    let known = this.acpSupport.get(path);
    if (!known) {
      known = (async () => {
        try {
          const { stdout, stderr } = await execFileAsync(path, ["--help"], {
            timeout: 10_000,
            env: await agentEnvironment(),
          });
          return /\bacp\b/i.test(`${stdout}\n${stderr}`);
        } catch {
          return true;
        }
      })();
      this.acpSupport.set(path, known);
    }
    return known;
  }

  label(id: string): string {
    return this.definitions.get(id)?.label ?? id;
  }

  /** Add every other registry agent, as plain ACP agents. */
  async loadRegistry(): Promise<void> {
    const featuredRegistryIds = new Set([
      "antigravity-acp",
      "cursor",
      "grok-build",
      "opencode",
      "gemini",
      "github-copilot-cli",
      "qwen-code",
      "goose",
      "devin",
      "amp-acp",
      "kimi",
    ]);
    for (const agent of await this.registry.load()) {
      if (NOT_FROM_REGISTRY.has(agent.id) || featuredRegistryIds.has(agent.id)) continue;
      if (this.definitions.has(agent.id)) continue;
      this.add(this.registryAgent(agent));
    }
    this.cached = null;
  }

  private registryAgent(agent: RegistryAgent): AgentDefinition {
    const registry = this.registry;
    return {
      id: agent.id,
      label: agent.name,
      protocol: "acp",
      group: "registry",
      installHint: "Available from the ACP registry",
      description: agent.description ?? null,
      binary: null,
      signInArgs: null,
      adapter: acpAdapter({
        id: agent.id,
        label: agent.name,
        signInHint: `Run ${agent.name} in a terminal once to sign in.`,
        launch: (context) =>
          registry.launch(agent, context.notify, { allowInstall: context.allowInstall ?? true }),
      }),
      probe: async () => {
        const { available, note } = await availability(agent);
        return {
          installed: available,
          source: "registry",
          note,
          path: null,
          version: agent.version,
        };
      },
    };
  }

  /**
   * What's available. Probing runs every CLI's --version, which takes
   * seconds, so this answers from the last result (memory, then disk) and
   * refreshes in the background when it's older than a minute.
   */
  statuses(refresh = false): Promise<ProviderStatus[]> {
    if (refresh) this.cached = null;
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.statuses;
    const previous = this.cached?.statuses ?? this.fromDisk();
    const fresh = this.probeAll();
    this.cached = { at: Date.now(), statuses: fresh };
    fresh.then(
      (statuses) =>
        void writeFile(this.statusCachePath, JSON.stringify(statuses)).catch(() => undefined),
      () => {
        this.cached = null;
      },
    );
    return previous.then((stale) => (stale && stale.length > 0 ? stale : fresh));
  }

  /**
   * The models an agent offers, asked from the agent itself. Asking means
   * starting it (seconds), so answers are cached in memory and on disk and
   * refreshed in the background once they're an hour old.
   */
  async models(id: string, refresh = false): Promise<AgentModels> {
    const adapter = this.adapters[id];
    if (!adapter) return { models: [], error: `Unknown agent: ${id}`, fetchedAt: Date.now() };
    const cached = this.modelCache.get(id) ?? (await this.modelsFromDisk())[id];
    const fresh = cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000;
    if (cached && !refresh) {
      if (!fresh) void this.fetchModels(id, adapter);
      return cached;
    }
    return this.fetchModels(id, adapter);
  }

  private fetchModels(id: string, adapter: ProviderAdapter): Promise<AgentModels> {
    let pending = this.modelFetches.get(id);
    if (!pending) {
      pending = (async (): Promise<AgentModels> => {
        try {
          const models = (await adapter.listModels?.()) ?? [];
          return {
            models,
            error: models.length === 0 ? "This agent didn't report any models; type one in." : null,
            fetchedAt: Date.now(),
          };
        } catch (error) {
          // Keep showing the last good list if there is one.
          const previous = this.modelCache.get(id);
          return {
            models: previous?.models ?? [],
            error: errorMessage(error),
            fetchedAt: Date.now(),
          };
        }
      })()
        .then(async (result) => {
          this.modelCache.set(id, result);
          await writeFile(
            this.modelCachePath,
            JSON.stringify(Object.fromEntries(this.modelCache)),
          ).catch(() => undefined);
          return result;
        })
        .finally(() => this.modelFetches.delete(id));
      this.modelFetches.set(id, pending);
    }
    return pending;
  }

  private get modelCachePath(): string {
    return join(this.toolsDir, "agent-models.json");
  }

  private async modelsFromDisk(): Promise<Record<string, AgentModels>> {
    if (this.modelCache.size > 0) return Object.fromEntries(this.modelCache);
    try {
      const saved = JSON.parse(await readFile(this.modelCachePath, "utf8")) as Record<
        string,
        AgentModels
      >;
      for (const [id, models] of Object.entries(saved)) this.modelCache.set(id, models);
      return saved;
    } catch {
      return {};
    }
  }

  private get statusCachePath(): string {
    return join(this.toolsDir, "agent-status.json");
  }

  private async fromDisk(): Promise<ProviderStatus[] | null> {
    try {
      const known = new Set(this.definitions.keys());
      const statuses = JSON.parse(await readFile(this.statusCachePath, "utf8")) as ProviderStatus[];
      // Only trust it if it describes the same catalog.
      return statuses.length === known.size &&
        statuses.every((s) => known.has(s.provider) && "auth" in s)
        ? statuses
        : null;
    } catch {
      return null;
    }
  }

  private probeAll(): Promise<ProviderStatus[]> {
    return Promise.all(
      [...this.definitions.values()].map(async (definition) => {
        const probe = await definition.probe();
        return {
          provider: definition.id,
          label: definition.label,
          protocol: definition.protocol,
          installHint: definition.installHint,
          group: definition.group,
          description: definition.description,
          ...probe,
          auth: await this.authState(definition, probe.path),
          canSignIn: probe.path !== null && definition.signInArgs !== null,
        };
      }),
    );
  }

  /**
   * Signed in? The CLI's own status command when it has one; otherwise what
   * asking it for models said ("Sign in to … to see its models").
   */
  private async authState(definition: AgentDefinition, path: string | null): Promise<AuthState> {
    if (definition.keyEnv?.(await this.keys())) {
      return { state: "ready", detail: "Runs on your OpenRouter key." };
    }
    const check = AUTH_CHECKS[definition.id];
    if (path && check)
      return check(path).catch(() => ({ state: "unknown" as const, detail: null }));
    const models = this.modelCache.get(definition.id);
    if (models?.error && classifySetup(models.error) === "sign-in") {
      return { state: "needs-sign-in", detail: models.error };
    }
    return { state: "unknown", detail: null };
  }

  /** Agents that run on these keys. */
  agentsUsing(keys: ProviderKeys): string[] {
    return [...this.definitions.values()]
      .filter((definition) => definition.keyEnv?.(keys))
      .map((definition) => definition.label);
  }

  /** A key was added or removed: re-probe sign-in and ask key agents for their models again. */
  keysChanged(): void {
    this.cached = null;
    for (const definition of this.definitions.values()) {
      if (!definition.keyEnv) continue;
      this.modelCache.delete(definition.id);
      void this.fetchModels(definition.id, definition.adapter);
    }
  }

  canSignIn(id: string): boolean {
    const definition = this.definitions.get(id);
    return Boolean(definition?.binary && definition.signInArgs);
  }

  /** Open Terminal running the agent's own sign-in command. */
  async signIn(id: string): Promise<{ opened: boolean; command: string }> {
    const definition = this.definitions.get(id);
    const path = definition?.binary ? await which(definition.binary) : null;
    if (!definition?.signInArgs || !path) {
      throw new Error(
        `${definition?.label ?? id} can't be signed in from here; ${definition?.installHint ?? ""}`,
      );
    }
    this.cached = null; // Re-check once they're done.
    this.modelCache.delete(id);
    return openTerminal([path, ...definition.signInArgs]);
  }
}
