import { homedir } from "node:os";
import { join } from "node:path";

export const SERVER_VERSION = "0.0.0";
export const DEFAULT_PORT = 3773;

export type ServerConfig = {
  port: number;
  host: string;
  homeDir: string;
  dbPath: string;
  settingsPath: string;
  worktreesDir: string;
  /** Agents installed from the ACP registry, and the registry cache. */
  toolsDir: string;
  /** Built web client to serve; null in dev, where Vite serves it. */
  webDistDir: string | null;
  /** Extra browser origins allowed to open the WebSocket (the Vite dev server). */
  devOrigins: string[];
};

export function resolveConfig(options: {
  port?: number;
  homeDir?: string;
  dev: boolean;
  webDistDir: string | null;
}): ServerConfig {
  const homeDir = options.homeDir ?? process.env.AGENTPLANE_HOME ?? join(homedir(), ".agentplane");
  return {
    port: options.port ?? DEFAULT_PORT,
    host: "127.0.0.1",
    homeDir,
    dbPath: join(homeDir, "state.sqlite"),
    settingsPath: join(homeDir, "settings.json"),
    worktreesDir: join(homeDir, "worktrees"),
    toolsDir: join(homeDir, "tools"),
    webDistDir: options.dev ? null : options.webDistDir,
    devOrigins: options.dev ? ["http://localhost:5173", "http://127.0.0.1:5173"] : [],
  };
}
