import type { TerminalInfo } from "@agentplane/contracts";
import {
  ChevronDown,
  PanelBottom,
  PanelBottomClose,
  PanelRight,
  PanelRightClose,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, Suspense, use, useCallback, useState } from "react";
import { cn } from "~/lib/cn.ts";
import { shortenPath } from "~/lib/format.ts";
import {
  closeTerminal,
  forgetLoad,
  mountTerminal,
  newTerminal,
  restartTerminal,
  selectTerminal,
  shellOptions,
  threadTerminals,
} from "~/lib/terminal-sessions.ts";
import {
  type Dock,
  setDock,
  setDrawerSize,
  toggleTerminal,
  useTerminals,
} from "~/lib/terminal-state.ts";
import { Menu } from "./dropdown.tsx";
import { Button, Eyebrow } from "./ui.tsx";

const NO_TERMINALS: TerminalInfo[] = [];

/** Shells in the thread's folder, docked under the conversation or beside it. */
export default function TerminalDrawer({ threadId }: { threadId: string }) {
  const dock = useTerminals((state) => state.dock);
  const size = useTerminals((state) => state.size[dock]);
  return (
    <section
      aria-label="Terminal"
      style={dock === "bottom" ? { height: size } : { width: size }}
      className={cn(
        "relative flex shrink-0 flex-col bg-panel",
        dock === "bottom" ? "border-t" : "border-l",
      )}
    >
      <ResizeHandle dock={dock} />
      <Suspense fallback={<Bar threadId={threadId} dock={dock} />}>
        <Terminals threadId={threadId} dock={dock} />
      </Suspense>
    </section>
  );
}

function Terminals({ threadId, dock }: { threadId: string; dock: Dock }) {
  const [attempt, setAttempt] = useState(0);
  const error = use(threadTerminals(threadId));
  const terminals = useTerminals((state) => state.threads[threadId]?.terminals ?? NO_TERMINALS);
  const activeId = useTerminals((state) => state.threads[threadId]?.active ?? null);
  const active = terminals.find((terminal) => terminal.id === activeId) ?? terminals[0];

  if (error) {
    return (
      <>
        <Bar threadId={threadId} dock={dock} />
        <div className="flex flex-col items-start gap-2 p-4">
          <p className="text-caption text-destructive">{error}</p>
          <Button
            size="sm"
            onClick={() => {
              forgetLoad(threadId);
              setAttempt(attempt + 1);
            }}
          >
            <RotateCw /> Try again
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <Bar threadId={threadId} dock={dock} terminals={terminals} active={active?.id ?? null} />
      <div className="relative min-h-0 flex-1 pt-1.5 pr-1 pb-1 pl-3">
        {active ? <TerminalView key={active.id} terminalId={active.id} /> : null}
        {active?.exited ? (
          <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md border bg-card px-3 py-2 shadow-sm">
            <span className="flex-1 text-caption text-foreground/60">
              {active.exitCode === null
                ? "This shell ended."
                : `This shell exited${active.exitCode ? ` with code ${active.exitCode}` : ""}.`}
            </span>
            <Button size="sm" onClick={() => void restartTerminal(threadId, active.id)}>
              <RotateCw /> Restart
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function TerminalView({ terminalId }: { terminalId: string }) {
  // Stable per terminal, so re-renders don't detach and reattach the screen.
  const mount = useCallback(
    (element: HTMLDivElement | null) => (element ? mountTerminal(terminalId, element) : undefined),
    [terminalId],
  );
  return <div ref={mount} className="h-full w-full" />;
}

function Bar({
  threadId,
  dock,
  terminals = NO_TERMINALS,
  active = null,
}: {
  threadId: string;
  dock: Dock;
  terminals?: TerminalInfo[];
  active?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const add = (shell?: string) => {
    setError(null);
    newTerminal(threadId, shell).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };
  const labels = tabLabels(terminals);
  const cwd = terminals.find((terminal) => terminal.id === active)?.cwd;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <Eyebrow className="shrink-0 px-1.5">Terminal</Eyebrow>
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        {terminals.map((terminal, index) => (
          <Tab
            key={terminal.id}
            terminal={terminal}
            label={labels[index] ?? terminal.title}
            selected={terminal.id === active}
            onSelect={() => selectTerminal(threadId, terminal.id)}
            onClose={() => void closeTerminal(threadId, terminal.id)}
          />
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 [&_svg]:size-3.5"
        aria-label="New terminal"
        title={error ?? "New terminal"}
        onClick={() => add()}
      >
        <Plus />
      </Button>
      <Suspense fallback={null}>
        <ShellMenu onPick={add} />
      </Suspense>
      <span
        className="hidden min-w-0 flex-1 truncate px-2 text-right text-mono-xs text-foreground/35 md:inline"
        title={cwd}
      >
        {cwd ? shortenPath(cwd) : null}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5 md:ml-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-6 [&_svg]:size-3.5"
          aria-label={dock === "bottom" ? "Dock to the right" : "Dock to the bottom"}
          title={dock === "bottom" ? "Dock to the right" : "Dock to the bottom"}
          onClick={() => setDock(dock === "bottom" ? "right" : "bottom")}
        >
          {dock === "bottom" ? <PanelRight /> : <PanelBottom />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 [&_svg]:size-3.5"
          aria-label="Hide terminal"
          title="Hide terminal (⌘J)"
          onClick={() => toggleTerminal(threadId)}
        >
          {dock === "bottom" ? <PanelBottomClose /> : <PanelRightClose />}
        </Button>
      </div>
    </div>
  );
}

/** "zsh", "zsh 2", "bash": numbered per shell. */
function tabLabels(terminals: TerminalInfo[]): string[] {
  const seen = new Map<string, number>();
  return terminals.map((terminal) => {
    const count = (seen.get(terminal.title) ?? 0) + 1;
    seen.set(terminal.title, count);
    return count === 1 ? terminal.title : `${terminal.title} ${count}`;
  });
}

/** Open a terminal with another installed shell (bash, fish, …). */
function ShellMenu({ onPick }: { onPick: (shell: string) => void }) {
  const shells = use(shellOptions());
  if (shells.length < 2) return null;
  return (
    <Menu
      label="New terminal with another shell"
      heading="New terminal"
      items={shells.map((shell) => ({
        id: shell.id,
        label: shell.id,
        hint: shell.isDefault ? "Default" : null,
        onSelect: () => onPick(shell.id),
      }))}
      triggerClassName="-ml-1 grid h-6 w-4 shrink-0 cursor-pointer place-items-center rounded-md text-foreground/50 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ChevronDown className="size-3" />
    </Menu>
  );
}

function Tab({
  terminal,
  label,
  selected,
  onSelect,
  onClose,
}: {
  terminal: TerminalInfo;
  label: string;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-6 shrink-0 items-center rounded-xs border border-transparent pr-0.5 pl-2 text-mono-xs",
        selected
          ? "border-border bg-card text-foreground"
          : "text-foreground/50 hover:bg-foreground/5 hover:text-foreground/80",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        className={cn(
          "cursor-pointer whitespace-nowrap",
          terminal.exited && "line-through opacity-60",
        )}
        title={terminal.cwd}
      >
        {label}
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        title="Close (ends the shell)"
        onClick={onClose}
        className={cn(
          "ml-1 grid size-4 cursor-pointer place-items-center rounded-xs text-foreground/40 hover:bg-foreground/10 hover:text-foreground",
          !selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function ResizeHandle({ dock }: { dock: Dock }) {
  const size = useTerminals((state) => state.size[dock]);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const start = dock === "bottom" ? event.clientY : event.clientX;
    const startSize = useTerminals.getState().size[dock];
    handle.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) =>
      setDrawerSize(dock, startSize + start - (dock === "bottom" ? moved.clientY : moved.clientX));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDrawerSize(dock, useTerminals.getState().size[dock], true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = dock === "bottom" ? "ArrowUp" : "ArrowLeft";
    const shrink = dock === "bottom" ? "ArrowDown" : "ArrowRight";
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault();
    setDrawerSize(dock, size + (event.key === grow ? 32 : -32), true);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element.
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize terminal"
      aria-orientation={dock === "bottom" ? "horizontal" : "vertical"}
      aria-valuenow={size}
      aria-valuemin={dock === "bottom" ? 120 : 300}
      aria-valuemax={
        dock === "bottom" ? Math.round(innerHeight * 0.75) : Math.round(innerWidth * 0.7)
      }
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute z-10 touch-none outline-none transition-colors hover:bg-brand-readable/50 focus-visible:bg-brand-readable/50",
        dock === "bottom"
          ? "inset-x-0 -top-px h-1 cursor-row-resize"
          : "inset-y-0 -left-px w-1 cursor-col-resize",
      )}
    />
  );
}
