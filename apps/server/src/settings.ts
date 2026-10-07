import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Automation, PermissionRule } from "@agentplane/contracts";
import { type Device, REMOTE_PORT, type RemoteMode } from "./remote.ts";
import { newId } from "./util.ts";

export type Settings = {
  composio: {
    /** Saved API key. Lives only in this file (owner-only) and server memory. */
    apiKey: string | null;
    /** Stable id for this machine's user in Composio. */
    userId: string;
    /** Reused Tool Router session, so agents share one MCP endpoint. */
    sessionId: string | null;
    toolsEnabled: boolean;
  };
  automations: Automation[];
  rules: PermissionRule[];
  /** Phone access: off unless turned on; paired devices by token hash. */
  remote: { enabled: boolean; mode: RemoteMode; port: number; devices: Device[] };
  /** Browsers on this computer signed in from the launch link, by token hash. */
  desktop: { sessions: DesktopSession[] };
  /**
   * Model provider keys the user entered, passed to agents in their
   * environment (never on a command line). Owner-only, like the rest.
   */
  keys: { openrouter: string | null };
  /** Setup commands from a project's agentplane.json the user approved, by project. */
  trustedSetups: Record<string, string>;
};

export type DesktopSession = {
  id: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
};

function defaults(): Settings {
  return {
    composio: {
      apiKey: null,
      userId: `agentplane-${newId()}`,
      sessionId: null,
      toolsEnabled: true,
    },
    automations: [],
    rules: [],
    remote: { enabled: false, mode: "lan", port: REMOTE_PORT, devices: [] },
    desktop: { sessions: [] },
    keys: { openrouter: null },
    trustedSetups: {},
  };
}

/** Small JSON settings file, written atomically with owner-only permissions. */
export class SettingsStore {
  private value: Settings;

  constructor(private readonly path: string) {
    this.value = this.read();
    this.write();
  }

  private read(): Settings {
    const base = defaults();
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Settings>;
      return {
        composio: { ...base.composio, ...saved.composio },
        automations: saved.automations ?? [],
        rules: saved.rules ?? [],
        remote: { ...base.remote, ...saved.remote },
        desktop: { ...base.desktop, ...saved.desktop },
        keys: { ...base.keys, ...saved.keys },
        trustedSetups: saved.trustedSetups ?? {},
      };
    } catch {
      return base;
    }
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  get(): Settings {
    return this.value;
  }

  update(change: (settings: Settings) => Settings): Settings {
    this.value = change(this.value);
    this.write();
    return this.value;
  }
}
