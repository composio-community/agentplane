import "@xterm/xterm/css/xterm.css";
import type { ShellOption, TerminalInfo } from "@agentplane/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import { client, setTerminalSink } from "./client.ts";
import {
  type Dock,
  patchTerminal,
  setTerminalOpen,
  setThreadTerminals,
  useTerminals,
} from "./terminal-state.ts";
import { useUi } from "./ui.ts";

/**
 * xterm instances live here, outside React, for as long as their shell does:
 * the drawer only mounts the one in front, so switching tabs or threads keeps
 * each screen and its scrollback.
 */
type Session = { term: Terminal; fit: FitAddon; host: HTMLDivElement; opened: boolean };

const sessions = new Map<string, Session>();
/** Output that arrived before its session was set up. */
const early = new Map<string, string>();
/**
 * New shells start at the grid size the drawer last fitted to (per dock, kept
 * across reloads), so they don't open at one size and redraw at another.
 */
type Grid = { cols: number; rows: number };
const GRID_KEY = "agentplane-terminal-grid";
let grids: Record<Dock, Grid> = (() => {
  const fallback = { bottom: { cols: 120, rows: 14 }, right: { cols: 70, rows: 40 } };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(GRID_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
})();
const currentGrid = (): Grid => grids[useTerminals.getState().dock];

function rememberGrid(grid: Grid): void {
  grids = { ...grids, [useTerminals.getState().dock]: grid };
  try {
    localStorage.setItem(GRID_KEY, JSON.stringify(grids));
  } catch {
    // Storage can be unavailable; shells just start at a default size.
  }
}

// ─── Theme: read from the design tokens ──────────────────────────────────────

const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });

/** Any CSS color (tokens use hex and oklch) as rgb(), which xterm understands. */
function rgb(color: string): string {
  if (!probe || !color) return color;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a = 255] = probe.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

function theme(): ITheme {
  const colors: Record<string, string> = {
    background: rgb(token("--term-background")),
    foreground: rgb(token("--term-foreground")),
    cursor: rgb(token("--term-cursor")),
    cursorAccent: rgb(token("--term-background")),
    selectionBackground: rgb(token("--term-selection")),
  };
  for (const name of ANSI) {
    colors[name] = rgb(token(`--term-${name}`));
    colors[`bright${name[0]?.toUpperCase()}${name.slice(1)}`] = rgb(token(`--term-bright-${name}`));
  }
  return colors as ITheme;
}

useUi.subscribe((state, previous) => {
  if (state.theme === previous.theme) return;
  const next = theme();
  for (const session of sessions.values()) session.term.options.theme = next;
});

const fontFamily = () => token("--font-mono") || "ui-monospace, monospace";

// ─── Sessions ────────────────────────────────────────────────────────────────

function createSession(info: TerminalInfo): Session {
  const existing = sessions.get(info.id);
  if (existing) return existing;
  const term = new Terminal({
    fontFamily: fontFamily(),
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5_000,
    theme: theme(),
    ...currentGrid(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  // ⌘K and ⌘J belong to the app.
  term.attachCustomKeyEventHandler(
    (event) => !(event.metaKey && /^[kj]$/i.test(event.key) && !event.altKey),
  );
  term.onData((data) => {
    void client.request("terminal.write", { terminalId: info.id, data }).catch(() => undefined);
  });
  term.onResize(({ cols, rows }) => {
    rememberGrid({ cols, rows });
    void client
      .request("terminal.resize", { terminalId: info.id, cols, rows })
      .catch(() => undefined);
  });
  const host = document.createElement("div");
  host.style.height = "100%";
  host.style.width = "100%";
  const session: Session = { term, fit, host, opened: false };
  sessions.set(info.id, session);
  const pending = early.get(info.id);
  if (pending) {
    early.delete(info.id);
    term.write(pending);
  }
  return session;
}

function dispose(terminalId: string): void {
  sessions.get(terminalId)?.term.dispose();
  sessions.delete(terminalId);
  early.delete(terminalId);
}

async function attach(info: TerminalInfo): Promise<void> {
  const session = createSession(info);
  const { terminal, scrollback } = await client.request("terminal.attach", {
    terminalId: info.id,
  });
  session.term.reset();
  session.term.write(scrollback);
  patchTerminal(info.id, terminal);
}

const DIM = (text: string) => `\r\n\x1b[2m${text}\x1b[0m\r\n`;

setTerminalSink({
  output(terminalId, data) {
    const session = sessions.get(terminalId);
    if (session) session.term.write(data);
    else early.set(terminalId, `${early.get(terminalId) ?? ""}${data}`.slice(-1_000_000));
  },
  exit(terminalId, exitCode) {
    sessions
      .get(terminalId)
      ?.term.write(DIM(`[Process exited${exitCode ? ` with code ${exitCode}` : ""}]`));
    patchTerminal(terminalId, { exited: true, exitCode });
  },
  reconnected() {
    for (const terminalId of sessions.keys()) {
      void client.request("terminal.attach", { terminalId }).then(
        ({ terminal, scrollback }) => {
          const session = sessions.get(terminalId);
          session?.term.reset();
          session?.term.write(scrollback);
          patchTerminal(terminalId, terminal);
        },
        () => {
          sessions.get(terminalId)?.term.write(DIM("[Terminal ended: the server restarted]"));
          patchTerminal(terminalId, { exited: true, exitCode: null });
        },
      );
    }
  },
});

const loads = new Map<string, Promise<string | null>>();

/**
 * Load a thread's terminals for the drawer, starting a shell if it has none.
 * Cached for `use()`; resolves to an error message instead of rejecting.
 */
export function threadTerminals(threadId: string): Promise<string | null> {
  let load = loads.get(threadId);
  if (!load) {
    load = (async () => {
      try {
        // xterm measures the font when it opens; make sure it's the real one.
        await document.fonts.load(`12px ${fontFamily()}`).catch(() => undefined);
        const existing = await client.request("terminal.list", { threadId });
        if (existing.length === 0) {
          await newTerminal(threadId);
          return null;
        }
        await Promise.all(existing.map(attach));
        setThreadTerminals(threadId, (current) => ({
          terminals: existing,
          active: existing.some((terminal) => terminal.id === current.active)
            ? current.active
            : (existing.at(-1)?.id ?? null),
        }));
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    loads.set(threadId, load);
  }
  return load;
}

/** Drop a failed load so the next attempt starts over. */
export function forgetLoad(threadId: string): void {
  loads.delete(threadId);
}

let shells: Promise<ShellOption[]> | null = null;

/** Shells installed on this computer, the login shell first. Cached for `use()`. */
export function shellOptions(): Promise<ShellOption[]> {
  shells ??= client.request("terminal.shells", {}).catch(() => []);
  return shells;
}

/** Start a shell in a new tab: the login shell, or `shell` (an id from `shellOptions`). */
export async function newTerminal(threadId: string, shell?: string): Promise<void> {
  const info = await client.request("terminal.open", {
    threadId,
    ...(shell ? { shell } : {}),
    ...currentGrid(),
  });
  createSession(info);
  setThreadTerminals(threadId, (current) => ({
    terminals: [...current.terminals, info],
    active: info.id,
  }));
}

export function selectTerminal(threadId: string, terminalId: string): void {
  setThreadTerminals(threadId, (current) => ({ ...current, active: terminalId }));
}

export async function closeTerminal(threadId: string, terminalId: string): Promise<void> {
  await client.request("terminal.close", { terminalId }).catch(() => undefined);
  dispose(terminalId);
  setThreadTerminals(threadId, (current) => {
    const index = current.terminals.findIndex((terminal) => terminal.id === terminalId);
    const terminals = current.terminals.filter((terminal) => terminal.id !== terminalId);
    const active =
      current.active === terminalId
        ? (terminals[Math.max(0, index - 1)]?.id ?? null)
        : current.active;
    return { terminals, active };
  });
  // Closing the last one hides the drawer; opening it again starts a fresh shell.
  if (useTerminals.getState().threads[threadId]?.terminals.length === 0) {
    loads.delete(threadId);
    setTerminalOpen(threadId, false);
  }
}

/** Replace an exited shell with a new one in the same tab. */
export async function restartTerminal(threadId: string, terminalId: string): Promise<void> {
  const info = await client.request("terminal.open", { threadId, ...currentGrid() });
  createSession(info);
  setThreadTerminals(threadId, (current) => ({
    terminals: current.terminals.map((terminal) => (terminal.id === terminalId ? info : terminal)),
    active: info.id,
  }));
  void client.request("terminal.close", { terminalId }).catch(() => undefined);
  dispose(terminalId);
}

function loadWebgl(term: Terminal): void {
  try {
    const webgl = new WebglAddon();
    // Browsers cap live WebGL contexts; if this one is reclaimed, fall back
    // to the DOM renderer.
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL: the DOM renderer is fine.
  }
}

/** Show a terminal in `container`, fitted to it. Returns the cleanup for a ref callback. */
export function mountTerminal(terminalId: string, container: HTMLElement): () => void {
  const session = sessions.get(terminalId);
  if (!session) return () => undefined;
  container.appendChild(session.host);
  if (!session.opened) {
    session.opened = true;
    session.term.open(session.host);
    loadWebgl(session.term);
  }
  const refit = () => {
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    try {
      session.fit.fit();
    } catch {
      // Not measurable yet (mid-layout); the next resize fits it.
    }
  };
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refit);
  });
  observer.observe(container);
  refit();
  session.term.refresh(0, session.term.rows - 1);
  session.term.focus();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    session.host.remove();
  };
}
