import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Variables package managers inject when the server runs under npx/pnpm.
 * Agent CLIs (many are Node programs) must not inherit them: NODE_PATH and
 * npm prefixes change how they resolve their own modules.
 */
const INJECTED = /^(NODE_PATH|NODE_OPTIONS|INIT_CWD|PNPM_.*|npm_.*)$/i;

/**
 * Keys the app itself uses. They never reach agents wholesale: Composio goes
 * through the local MCP proxy, OpenRouter only to agents that run on it.
 */
const APP_SECRETS = new Set(["COMPOSIO_API_KEY", "OPENROUTER_API_KEY"]);

let environment: Promise<NodeJS.ProcessEnv> | null = null;

/**
 * The environment agents run with: ours, minus package-manager noise, with
 * PATH taken from the user's login shell. Running under npx/pnpm prepends
 * every parent `node_modules/.bin`, which can shadow the user's real CLIs;
 * GUI launches (Electron) get a minimal PATH. The login shell fixes both.
 */
export function agentEnvironment(): Promise<NodeJS.ProcessEnv> {
  environment ??= (async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!INJECTED.test(key) && !APP_SECRETS.has(key)) env[key] = value;
    }
    env.PATH = (await loginShellPath()) ?? withoutNodeModulesBins(process.env.PATH ?? "");
    return env;
  })();
  return environment;
}

async function loginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL;
  if (!shell || process.platform === "win32") return null;
  try {
    const marker = "__AGENTPLANE_PATH__";
    const { stdout } = await exec(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], {
      timeout: 5_000,
      env: { ...process.env, PATH: withoutNodeModulesBins(process.env.PATH ?? "") },
    });
    const match = stdout.match(new RegExp(`${marker}(.*)${marker}`, "s"));
    return match?.[1] ? match[1] : null;
  } catch {
    return null;
  }
}

function withoutNodeModulesBins(path: string): string {
  return path
    .split(delimiter)
    .filter((dir) => dir && !/[\\/]node_modules[\\/]\.bin$/.test(dir))
    .join(delimiter);
}

/** Resolve a binary on the agents' PATH, the way the user's shell would. */
export async function which(binary: string): Promise<string | null> {
  const env = await agentEnvironment();
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

export async function binaryVersion(path: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await exec(path, args, {
      timeout: 10_000,
      env: await agentEnvironment(),
    });
    return (stdout.trim() || stderr.trim()).split("\n")[0] ?? null;
  } catch {
    // Installed but not runnable (or no version flag); report it without one.
    return null;
  }
}

export async function requireBinary(binary: string, label: string): Promise<string> {
  const path = await which(binary);
  if (!path) {
    throw new Error(
      `Could not find the \`${binary}\` CLI for ${label} on your PATH. Install it and sign in, then try again.`,
    );
  }
  return path;
}
