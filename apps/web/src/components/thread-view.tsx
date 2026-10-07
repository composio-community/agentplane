import type { Item, RuntimeMode, Thread, Turn } from "@agentplane/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, FolderOpen, GitBranch, Square, SquareTerminal, Trash2, Zap } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from "react";
import { client } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { costLabel, RUNTIME_MODES, shortenPath } from "~/lib/format.ts";
import { type ThreadDetail, useAgentLabel, useApp } from "~/lib/store.ts";
import { terminalsAvailable, toggleTerminal, useTerminals } from "~/lib/terminal-state.ts";
import { TimelineItem, TurnFooter } from "./items.tsx";
import { ThreadAgentSelect, ThreadModelSelect } from "./model-picker.tsx";
import { Button, Chip, Eyebrow, Kbd, Segmented, STATUS_LABEL, StatusDot } from "./ui.tsx";

// xterm is only downloaded once someone opens a terminal.
const TerminalDrawer = lazy(() => import("./terminal-drawer.tsx"));

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useApp((state) => state.threads[threadId]);
  const detail = useApp((state) => state.details[threadId]);
  if (!thread || !detail) {
    return (
      <div className="grid flex-1 place-items-center text-body-sm text-foreground/45">
        This thread no longer exists.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadHeader thread={thread} />
      <ThreadBody threadId={thread.id}>
        <Timeline detail={detail} cwd={thread.cwd} />
        <Composer key={thread.id} thread={thread} />
      </ThreadBody>
    </div>
  );
}

/** The conversation, with the terminal drawer under it or beside it when open. */
function ThreadBody({ threadId, children }: { threadId: string; children: ReactNode }) {
  const open = useTerminals((state) => terminalsAvailable && Boolean(state.open[threadId]));
  const dock = useTerminals((state) => state.dock);
  return (
    <div className={cn("flex min-h-0 flex-1", dock === "right" ? "flex-row" : "flex-col")}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {open ? (
        <Suspense fallback={null}>
          <TerminalDrawer key={threadId} threadId={threadId} />
        </Suspense>
      ) : null}
    </div>
  );
}

function ThreadHeader({ thread }: { thread: Thread }) {
  const navigate = useNavigate();
  const setMode = (runtimeMode: RuntimeMode) =>
    void client.request("thread.setRuntimeMode", { threadId: thread.id, runtimeMode });
  const remove = async () => {
    if (!confirm(`Delete “${thread.title}”? Its worktree stays on disk.`)) return;
    await client.request("thread.delete", { threadId: thread.id });
    await navigate({ to: "/" });
  };

  return (
    <header className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-panel px-5 py-2">
      <div className="flex min-w-48 flex-1 basis-64 items-center gap-2.5">
        <StatusDot status={thread.status} />
        <h1 className="truncate text-body-sm" title={thread.title}>
          {thread.title}
        </h1>
        <Eyebrow className="hidden shrink-0 sm:inline">{STATUS_LABEL[thread.status]}</Eyebrow>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {thread.origin ? (
          <Chip title="Started by an automation" className="text-brand-readable">
            <Zap className="size-3" />
            <span className="normal-case">{thread.origin}</span>
          </Chip>
        ) : null}
        <ThreadAgentSelect
          threadId={thread.id}
          provider={thread.provider}
          disabled={thread.status === "running" || thread.status === "needs-input"}
        />
        <ThreadModelSelect
          threadId={thread.id}
          provider={thread.provider}
          model={thread.model}
          disabled={thread.status === "running" || thread.status === "needs-input"}
        />
        {thread.branch ? (
          <Chip title={`Worktree branch: ${thread.branch}`}>
            <GitBranch className="size-3" />
            <span className="normal-case">{thread.branch}</span>
          </Chip>
        ) : null}
        <Chip title={thread.cwd}>
          <FolderOpen className="size-3" />
          <span className="max-w-48 truncate normal-case">{shortenPath(thread.cwd)}</span>
        </Chip>
        {thread.costUsd !== null ? (
          <Chip title="Estimated cost">{costLabel(thread.costUsd)}</Chip>
        ) : null}
        <Segmented
          value={thread.runtimeMode}
          onChange={setMode}
          options={RUNTIME_MODES}
          className="ml-1"
        />
        {terminalsAvailable ? <TerminalToggle threadId={thread.id} /> : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete thread"
          title="Delete thread"
          onClick={remove}
        >
          <Trash2 />
        </Button>
      </div>
    </header>
  );
}

function TerminalToggle({ threadId }: { threadId: string }) {
  const open = useTerminals((state) => Boolean(state.open[threadId]));
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Terminal"
      aria-pressed={open}
      title={`${open ? "Hide" : "Open"} terminal (⌘J)`}
      onClick={() => toggleTerminal(threadId)}
      className={cn(open && "bg-foreground/5 text-brand-readable")}
    >
      <SquareTerminal />
    </Button>
  );
}

type Row = { kind: "item"; item: Item } | { kind: "turn"; turn: Turn };

/** Items in order, with a footer closing each turn. */
function buildRows(detail: ThreadDetail): Row[] {
  const turns = new Map(detail.turns.map((turn) => [turn.id, turn]));
  const rows: Row[] = [];
  let current: string | null = null;
  const closeTurn = () => {
    const turn = current ? turns.get(current) : undefined;
    if (turn) rows.push({ kind: "turn", turn });
  };
  for (const item of detail.items) {
    if (item.turnId !== current) {
      closeTurn();
      current = item.turnId;
    }
    rows.push({ kind: "item", item });
  }
  closeTurn();
  return rows;
}

function Timeline({ detail, cwd }: { detail: ThreadDetail; cwd: string }) {
  const rows = useMemo(() => buildRows(detail), [detail]);
  const latestTurn = detail.turns.at(-1)?.id;
  return (
    // column-reverse keeps the view pinned to the newest content as it streams
    // in, without any scroll bookkeeping.
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <div className="mx-auto flex w-full max-w-prose flex-col gap-4 px-5 py-6">
        {rows.length === 0 ? (
          <div className="flex flex-col gap-2 py-16 text-center">
            <Eyebrow tone="brand">Ready</Eyebrow>
            <p className="text-body-sm text-foreground/50">
              Describe a task. The agent works in this thread's folder and asks before anything
              risky, depending on its permissions.
            </p>
          </div>
        ) : (
          rows.map((row) =>
            row.kind === "item" ? (
              <TimelineItem
                key={row.item.id}
                item={row.item}
                cwd={cwd}
                latest={row.item.turnId === latestTurn}
              />
            ) : (
              <TurnFooter key={`turn:${row.turn.id}`} turn={row.turn} />
            ),
          )
        )}
      </div>
    </div>
  );
}

function Composer({ thread }: { thread: Thread }) {
  const agent = useAgentLabel(thread.provider);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = thread.status === "running" || thread.status === "needs-input";

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const message = text.trim();
    if (!message || busy || sending) return;
    setSending(true);
    setError(null);
    try {
      await client.request("thread.sendMessage", { threadId: thread.id, text: message });
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const interrupt = () => void client.request("thread.interrupt", { threadId: thread.id });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape" && busy) {
      event.preventDefault();
      interrupt();
    }
  };

  return (
    <form onSubmit={send} className="border-t bg-background px-5 pt-3 pb-4">
      <div className="mx-auto flex max-w-prose flex-col gap-2">
        <div
          className={cn(
            "flex flex-col rounded-xl border bg-card transition-colors focus-within:border-foreground/25",
            busy && "opacity-90",
          )}
        >
          <textarea
            data-composer
            autoFocus
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() =>
              void client.request("thread.prewarm", { threadId: thread.id }).catch(() => undefined)
            }
            placeholder={
              busy ? "The agent is working. Press Esc to interrupt." : `Message ${agent}…`
            }
            className="max-h-64 min-h-11 resize-none bg-transparent px-4 pt-3 text-body-sm outline-none [field-sizing:content] placeholder:text-foreground/35"
          />
          <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
            <span className="px-2 text-mono-xs text-foreground/35">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline
              {busy ? (
                <>
                  {" "}
                  · <Kbd>Esc</Kbd> stop
                </>
              ) : null}
            </span>
            {busy ? (
              <Button variant="secondary" size="sm" onClick={interrupt}>
                <Square className="size-3! fill-current" /> Stop
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!text.trim() || sending}
                aria-label="Send"
              >
                <ArrowUp /> Send
              </Button>
            )}
          </div>
        </div>
        {error ? <p className="text-caption text-destructive">{error}</p> : null}
        <p className="text-mono-xs text-foreground/30">
          {RUNTIME_MODES.find((mode) => mode.value === thread.runtimeMode)?.title}
        </p>
      </div>
    </form>
  );
}
