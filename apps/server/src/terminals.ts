import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ServerMessage, ShellOption, TerminalInfo } from "@agentplane/contracts";
import type { IPty } from "node-pty";
import { UserError } from "./orchestrator.ts";
import { agentEnvironment, which } from "./providers/detect.ts";
import { newId } from "./util.ts";

/** A connected window that receives terminal output. */
export type Peer = { send: (message: ServerMessage) => void };

/** Scrollback kept per terminal, replayed when a window (re)attaches. */
const SCROLLBACK_CHARS = 256 * 1024;
/** Output is batched this long before it's sent, so a burst is one message. */
const FLUSH_MS = 8;

type Terminal = {
  info: TerminalInfo;
  pty: IPty;
  scrollback: string;
  pending: string;
  flush: NodeJS.Timeout | null;
  peers: Set<Peer>;
};

type NodePty = typeof import("node-pty");
let nodePty: Promise<NodePty> | null = null;

/**
 * node-pty is native; load it on first use so the server still runs where it
 * can't. pnpm drops the execute bit on its spawn-helper, so restore that first.
 */
function loadPty(): Promise<NodePty> {
  nodePty ??= (async () => {
    const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    for (const helper of [
      join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(root, "build", "Release", "spawn-helper"),
    ]) {
      if (!existsSync(helper)) continue;
      const { mode } = statSync(helper);
      if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
    }
    return import("node-pty");
  })();
  nodePty.catch(() => {
    nodePty = null;
  });
  return nodePty;
}

function userShell(): string {
  const shell = process.env.SHELL || userInfo().shell;
  return shell && existsSync(shell) ? shell : "/bin/zsh";
}

/** Shells offered besides the login shell, found on the login PATH (so Homebrew's bash wins). */
const OFFERED_SHELLS = ["zsh", "bash", "fish", "nu", "pwsh"];

/** Each starts as a login shell, so the user's profile and PATH load. */
const loginArgs = (id: string) => (id === "pwsh" ? ["-Login"] : ["-l"]);

export async function availableShells(): Promise<ShellOption[]> {
  const login = userShell();
  const shells: ShellOption[] = [{ id: basename(login), path: login, isDefault: true }];
  for (const id of OFFERED_SHELLS) {
    if (shells.some((shell) => shell.id === id)) continue;
    const path = await which(id);
    if (path) shells.push({ id, path, isDefault: false });
  }
  return shells;
}

/**
 * Shells in a thread's folder (or worktree), for the terminal drawer. They
 * outlive any one window: output streams to attached windows and is kept as
 * scrollback, so reloading or switching threads picks up where it was.
 */
export class Terminals {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly threadTarget: (threadId: string) => {
      cwd: string;
      env: Record<string, string>;
    },
  ) {}

  list(threadId: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((terminal) => terminal.info.threadId === threadId)
      .map((terminal) => terminal.info);
  }

  async open(
    threadId: string,
    cols: number,
    rows: number,
    peer: Peer,
    shellId?: string,
  ): Promise<TerminalInfo> {
    const { cwd, env } = this.threadTarget(threadId);
    if (!existsSync(cwd)) throw new UserError(`This thread's folder is gone: ${cwd}`);
    // Only shells we found ourselves; never an arbitrary path from the wire.
    const shells = await availableShells();
    const shell = shellId ? shells.find((option) => option.id === shellId) : shells[0];
    if (!shell) throw new UserError(`${shellId} isn't installed on this computer.`);
    let pty: NodePty;
    try {
      pty = await loadPty();
    } catch (error) {
      throw new UserError(
        `Terminals aren't available here: node-pty couldn't load (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const shellProcess = pty.spawn(shell.path, loginArgs(shell.id), {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...(await agentEnvironment()),
        ...env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "Agentplane",
        // macOS's /bin/bash otherwise opens with a "switch to zsh" notice.
        BASH_SILENCE_DEPRECATION_WARNING: "1",
      },
    });
    const terminal: Terminal = {
      info: {
        id: newId(),
        threadId,
        title: shell.id,
        cwd,
        exitCode: null,
        exited: false,
      },
      pty: shellProcess,
      scrollback: "",
      pending: "",
      flush: null,
      peers: new Set([peer]),
    };
    this.terminals.set(terminal.info.id, terminal);
    shellProcess.onData((data) => this.onData(terminal, data));
    shellProcess.onExit(({ exitCode }) => {
      this.flush(terminal);
      terminal.info = { ...terminal.info, exited: true, exitCode };
      for (const each of terminal.peers) {
        each.send({ type: "terminal.exit", terminalId: terminal.info.id, exitCode });
      }
    });
    return terminal.info;
  }

  attach(terminalId: string, peer: Peer): { terminal: TerminalInfo; scrollback: string } {
    const terminal = this.require(terminalId);
    // Send what's pending to existing windows first: the scrollback returned
    // here already includes it, so the new window mustn't get it twice.
    this.flush(terminal);
    terminal.peers.add(peer);
    return { terminal: terminal.info, scrollback: terminal.scrollback };
  }

  write(terminalId: string, data: string): void {
    const terminal = this.require(terminalId);
    if (!terminal.info.exited) terminal.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.require(terminalId);
    if (!terminal.info.exited) terminal.pty.resize(cols, rows);
  }

  close(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    this.terminals.delete(terminalId);
    if (terminal.flush) clearTimeout(terminal.flush);
    if (!terminal.info.exited) terminal.pty.kill();
  }

  closeThread(threadId: string): void {
    for (const terminal of this.list(threadId)) this.close(terminal.id);
  }

  /** A window went away: stop sending it output. The shells keep running. */
  detach(peer: Peer): void {
    for (const terminal of this.terminals.values()) terminal.peers.delete(peer);
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private require(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new UserError("That terminal has closed.");
    return terminal;
  }

  private onData(terminal: Terminal, data: string): void {
    terminal.scrollback += data;
    if (terminal.scrollback.length > SCROLLBACK_CHARS * 1.25) {
      // Trim at a line break so replay doesn't start mid-line.
      const cut = terminal.scrollback.length - SCROLLBACK_CHARS;
      const lineStart = terminal.scrollback.indexOf("\n", cut);
      terminal.scrollback = terminal.scrollback.slice(lineStart === -1 ? cut : lineStart + 1);
    }
    terminal.pending += data;
    terminal.flush ??= setTimeout(() => this.flush(terminal), FLUSH_MS);
  }

  private flush(terminal: Terminal): void {
    if (terminal.flush) clearTimeout(terminal.flush);
    terminal.flush = null;
    if (!terminal.pending) return;
    const message: ServerMessage = {
      type: "terminal.output",
      terminalId: terminal.info.id,
      data: terminal.pending,
    };
    terminal.pending = "";
    for (const peer of terminal.peers) peer.send(message);
  }
}
