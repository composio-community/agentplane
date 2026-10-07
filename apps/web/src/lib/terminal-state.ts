import type { TerminalInfo } from "@agentplane/contracts";
import { create } from "zustand";

export type Dock = "bottom" | "right";

type TerminalState = {
  /** Threads whose terminal drawer is showing. */
  open: Record<string, true>;
  dock: Dock;
  /** Drawer height when docked at the bottom, width when docked right (px). */
  size: Record<Dock, number>;
  /** Each thread's terminals, in tab order, and the one in front. */
  threads: Record<string, { terminals: TerminalInfo[]; active: string | null }>;
};

const STORAGE_KEY = "agentplane-terminal";

type Saved = { open?: string[]; dock?: Dock; size?: Partial<Record<Dock, number>> };

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

const saved = load();

export const useTerminals = create<TerminalState>(() => ({
  open: Object.fromEntries((saved.open ?? []).map((id) => [id, true as const])),
  dock: saved.dock === "right" ? "right" : "bottom",
  size: { bottom: 280, right: 520, ...saved.size },
  threads: {},
}));

function persist(): void {
  const { open, dock, size } = useTerminals.getState();
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ open: Object.keys(open).slice(-50), dock, size } satisfies Saved),
    );
  } catch {
    // Storage can be unavailable (private windows); the drawer still works.
  }
}

/**
 * Shells run on this computer, so only the desktop app gets them (the server
 * refuses paired phones too).
 */
export const terminalsAvailable = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);

export function isTerminalOpen(threadId: string): boolean {
  return Boolean(useTerminals.getState().open[threadId]);
}

export function setTerminalOpen(threadId: string, open: boolean): void {
  useTerminals.setState((state) => {
    const next = { ...state.open };
    if (open) next[threadId] = true;
    else delete next[threadId];
    return { open: next };
  });
  persist();
}

export function toggleTerminal(threadId: string): void {
  if (!terminalsAvailable) return;
  const opening = !isTerminalOpen(threadId);
  setTerminalOpen(threadId, opening);
  // Hand the keyboard back to the message box when the drawer goes away.
  if (!opening) document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus();
}

export function setDock(dock: Dock): void {
  useTerminals.setState({ dock });
  persist();
}

export function setDrawerSize(dock: Dock, px: number, save = false): void {
  const limit = dock === "bottom" ? innerHeight * 0.75 : innerWidth * 0.7;
  const min = dock === "bottom" ? 120 : 300;
  const size = Math.round(Math.max(min, Math.min(limit, px)));
  useTerminals.setState((state) => ({ size: { ...state.size, [dock]: size } }));
  if (save) persist();
}

export function setThreadTerminals(
  threadId: string,
  update: (current: { terminals: TerminalInfo[]; active: string | null }) => {
    terminals: TerminalInfo[];
    active: string | null;
  },
): void {
  useTerminals.setState((state) => ({
    threads: {
      ...state.threads,
      [threadId]: update(state.threads[threadId] ?? { terminals: [], active: null }),
    },
  }));
}

/** Update one terminal's info wherever it is (it exited, or came back). */
export function patchTerminal(terminalId: string, patch: Partial<TerminalInfo>): void {
  useTerminals.setState((state) => {
    const threads = { ...state.threads };
    for (const [threadId, entry] of Object.entries(threads)) {
      if (!entry.terminals.some((terminal) => terminal.id === terminalId)) continue;
      threads[threadId] = {
        ...entry,
        terminals: entry.terminals.map((terminal) =>
          terminal.id === terminalId ? { ...terminal, ...patch } : terminal,
        ),
      };
    }
    return { threads };
  });
}
