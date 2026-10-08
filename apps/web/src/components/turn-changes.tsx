import type { FileChange, FileDiff, Turn } from "@agentplane/contracts";
import {
  ChevronRight,
  FileDiff as FileDiffIcon,
  Loader2,
  SquareArrowOutUpRight,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { client } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { openInEditor } from "~/lib/editors.ts";
import { useApp } from "~/lib/store.ts";
import { terminalsAvailable } from "~/lib/terminal-state.ts";
import { Diff } from "./diff.tsx";
import { Button, Chip } from "./ui.tsx";

const STATUS_MARK: Record<FileChange["status"], { mark: string; className: string }> = {
  added: { mark: "A", className: "text-success" },
  modified: { mark: "M", className: "text-brand-readable" },
  deleted: { mark: "D", className: "text-destructive" },
};

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 text-mono-xs tabular-nums">
      <span className="text-success">+{additions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

/**
 * What a turn changed in the working tree (from the git checkpoints taken
 * around it): a summary, the diff on demand, and a way to undo it.
 */
export function TurnChanges({ turn }: { turn: Turn }) {
  const checkpoint = turn.checkpoint;
  const threadBusy = useApp((state) => {
    const status = state.threads[turn.threadId]?.status;
    return status === "running" || status === "needs-input";
  });
  const [open, setOpen] = useState(false);
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  if (!checkpoint?.after || checkpoint.files.length === 0) return null;
  const files = checkpoint.files;
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !diffs) {
      setLoadError(null);
      client.request("turn.diff", { threadId: turn.threadId, turnId: turn.id }).then(
        (result) => setDiffs(result.files),
        (err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const revert = async (overwrite: boolean) => {
    const count = files.length === 1 ? "1 file" : `${files.length} files`;
    const question = overwrite
      ? `Put ${count} back exactly as they were before this turn? Later edits to them are lost.`
      : `Undo this turn's changes to ${count}? The agent is told on your next message.`;
    if (!confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await client.request("turn.revert", { threadId: turn.threadId, turnId: turn.id, overwrite });
      setConflict(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setConflict(!overwrite && message.startsWith("Files this turn changed were edited again"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card/60">
      <div
        className={cn("flex items-center gap-2 px-3 py-1.5", checkpoint.reverted && "opacity-60")}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <FileDiffIcon className="size-3.5 shrink-0 text-foreground/45" />
          <span
            className={cn("text-body-sm text-foreground/80", checkpoint.reverted && "line-through")}
          >
            {files.length === 1 ? "1 file changed" : `${files.length} files changed`}
          </span>
          <Counts additions={additions} deletions={deletions} />
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-foreground/35 transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
        {checkpoint.reverted ? (
          <Chip>Reverted</Chip>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || threadBusy}
            title={threadBusy ? "Stop the agent first" : "Undo what this turn changed"}
            onClick={() => void revert(false)}
          >
            <Undo2 /> Revert
          </Button>
        )}
      </div>
      {error ? (
        <div className="flex flex-col gap-2 border-t px-3 py-2">
          <pre className="whitespace-pre-wrap text-caption text-destructive">{error}</pre>
          {conflict ? (
            <div>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void revert(true)}>
                Restore these files anyway
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-1 border-t px-3 py-2">
          {loadError ? <p className="text-caption text-destructive">{loadError}</p> : null}
          {!diffs && !loadError ? (
            <div className="flex items-center gap-2 py-1 text-caption text-foreground/45">
              <Loader2 className="size-3.5 animate-spin" /> Loading diff…
            </div>
          ) : null}
          {(diffs ?? []).map((file) => (
            <FileRow key={file.path} file={file} threadId={turn.threadId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Where a file's first hunk starts in the new version, to open it there. */
function firstLine(patch: string): number | undefined {
  const start = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(patch)?.[1];
  return start ? Math.max(1, Number(start)) : undefined;
}

function FileRow({ file, threadId }: { file: FileDiff; threadId: string }) {
  const { mark, className } = STATUS_MARK[file.status];
  const canOpen = terminalsAvailable && file.status !== "deleted";
  const row = (
    <>
      <span className={cn("w-3 shrink-0 text-mono-xs", className)}>{mark}</span>
      <span className="min-w-0 flex-1 truncate text-mono-sm text-foreground/80" title={file.path}>
        {file.path}
      </span>
      {canOpen ? (
        <button
          type="button"
          aria-label={`Open ${file.path} in your editor`}
          title="Open in your editor"
          onClick={(event) => {
            // It sits in the row that expands the diff.
            event.preventDefault();
            event.stopPropagation();
            void openInEditor(threadId, { path: file.path, line: firstLine(file.patch) });
          }}
          className="shrink-0 cursor-pointer rounded-xs p-0.5 text-foreground/35 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <SquareArrowOutUpRight className="size-3.5" />
        </button>
      ) : null}
      {file.additions === null ? (
        <span className="shrink-0 text-mono-xs text-foreground/40">binary</span>
      ) : (
        <Counts additions={file.additions} deletions={file.deletions ?? 0} />
      )}
    </>
  );
  if (!file.patch) {
    return <div className="group/row flex items-center gap-2 py-1 pl-1">{row}</div>;
  }
  return (
    <details className="group">
      <summary className="group/row flex cursor-pointer list-none items-center gap-2 rounded-xs py-1 pl-1 hover:bg-foreground/[0.03]">
        {row}
        <ChevronRight className="size-3 shrink-0 text-foreground/35 transition-transform group-open:rotate-90" />
      </summary>
      <div className="pt-1 pb-2">
        <Diff text={file.patch} />
      </div>
    </details>
  );
}
