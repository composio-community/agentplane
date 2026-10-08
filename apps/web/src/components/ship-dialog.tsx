import type { GitStatus, MethodResult } from "@agentplane/contracts";
import { ExternalLink, GitBranch, GitCommitHorizontal, Loader2 } from "lucide-react";
import { Suspense, use, useState } from "react";
import { client } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { useApp } from "~/lib/store.ts";
import { Field, inputClass, Modal } from "./modal.tsx";
import { Button, Chip, Eyebrow } from "./ui.tsx";

type Loaded = { status: GitStatus } | { error: string };
type Shipped = MethodResult<"git.ship">;

function load(threadId: string): Promise<Loaded> {
  return client.request("git.status", { threadId }).then(
    (status) => ({ status }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );
}

/** The header button: commit, push and open a pull request from this thread. */
export function ShipButton({ threadId, disabled }: { threadId: string; disabled: boolean }) {
  const [loading, setLoading] = useState<Promise<Loaded> | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Commit and push"
        title={disabled ? "Wait for the agent to finish" : "Commit, push, open a pull request"}
        disabled={disabled}
        onClick={() => setLoading(load(threadId))}
      >
        <GitCommitHorizontal />
      </Button>
      {loading ? (
        <Modal eyebrow="Ship" title="Commit and push" onClose={() => setLoading(null)}>
          <Suspense
            fallback={
              <div className="flex items-center gap-2 text-caption text-foreground/50">
                <Loader2 className="size-3.5 animate-spin" /> Checking the repository…
              </div>
            }
          >
            <ShipForm threadId={threadId} loading={loading} onClose={() => setLoading(null)} />
          </Suspense>
        </Modal>
      ) : null}
    </>
  );
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const CHANGE_MARK: Record<GitStatus["changes"][number]["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "U",
};

function ShipForm({
  threadId,
  loading,
  onClose,
}: {
  threadId: string;
  loading: Promise<Loaded>;
  onClose: () => void;
}) {
  const loaded = use(loading);
  const thread = useApp((state) => state.threads[threadId]);
  const lastReply = useApp((state) => {
    const item = state.details[threadId]?.items.findLast(
      (entry) => entry.kind === "assistant_message",
    );
    return item?.kind === "assistant_message" ? item.text : "";
  });
  const status = "status" in loaded ? loaded.status : null;
  const title = thread?.title ?? "";

  const onDefault = Boolean(status && (!status.branch || status.branch === status.defaultBranch));
  const canPr = Boolean(status?.remote && status.gh === "ready" && !status.pr);
  const [branch, setBranch] = useState(onDefault && canPr ? `agentplane/${slug(title)}` : "");
  const [message, setMessage] = useState(title);
  const [push, setPush] = useState(Boolean(status?.remote));
  const [openPr, setOpenPr] = useState(canPr);
  const [prTitle, setPrTitle] = useState(title);
  const [prBody, setPrBody] = useState(lastReply.slice(0, 4000));
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shipped, setShipped] = useState<Shipped | null>(null);

  if (!status)
    return (
      <p className="text-body-sm text-destructive">{"error" in loaded ? loaded.error : null}</p>
    );
  if (!status.repo) {
    return (
      <p className="text-body-sm text-foreground/65">
        This thread's folder isn't a git repository.
      </p>
    );
  }

  if (shipped) {
    return (
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1.5 text-body-sm">
          {shipped.branch ? (
            <li>
              Switched to <code className="text-mono-sm">{shipped.branch}</code>
            </li>
          ) : null}
          {shipped.sha ? (
            <li>
              Committed <code className="text-mono-sm">{shipped.sha}</code>
            </li>
          ) : null}
          {shipped.pushed ? <li>Pushed to origin</li> : null}
        </ul>
        <div className="flex flex-wrap gap-2">
          {shipped.prUrl ? (
            <Button
              variant="primary"
              onClick={() => window.open(shipped.prUrl ?? "", "_blank", "noreferrer")}
            >
              <ExternalLink /> Open the pull request
            </Button>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  const changes = status.changes.length;
  const branching = onDefault && branch.trim().length > 0;
  const willCommit = changes > 0 && message.trim().length > 0;
  const prPossible = canPr && (!onDefault || branching);
  const willPr = openPr && prPossible;
  const willPush = (push || willPr) && Boolean(status.remote);
  const nothing = !willCommit && !willPush && !branching;
  const label =
    [willCommit ? "Commit" : null, willPush ? "push" : null, willPr ? "open PR" : null]
      .filter(Boolean)
      .join(", ")
      .replace(/^./, (first) => first.toUpperCase()) || "Nothing to do";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setShipped(
        await client.request("git.ship", {
          threadId,
          ...(branching ? { branch: branch.trim() } : {}),
          ...(willCommit ? { message: message.trim() } : {}),
          push: willPush,
          ...(willPr ? { pr: { title: prTitle.trim() || title, body: prBody, draft } } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!nothing && !busy) void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>
          <GitBranch className="size-3" />
          <span className="normal-case">{status.branch ?? "detached HEAD"}</span>
        </Chip>
        {status.upstream ? (
          <Chip title="Commits not pushed / not pulled">
            ↑{status.ahead} ↓{status.behind}
          </Chip>
        ) : null}
        {status.remote ? (
          <Chip className="min-w-0 max-w-full normal-case" title={status.remote}>
            <span className="truncate">{status.remote}</span>
          </Chip>
        ) : (
          <Chip>No remote</Chip>
        )}
        {status.pr ? (
          <a href={status.pr.url} target="_blank" rel="noreferrer">
            <Chip className="text-brand-readable hover:border-foreground/25">
              PR #{status.pr.number} · {status.pr.state.toLowerCase()}{" "}
              <ExternalLink className="size-3" />
            </Chip>
          </a>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Eyebrow>
          {changes === 0
            ? "No uncommitted changes"
            : `${changes} changed ${changes === 1 ? "file" : "files"}`}
        </Eyebrow>
        {changes > 0 ? (
          <ul className="max-h-36 overflow-y-auto rounded-md border bg-background px-3 py-1.5">
            {status.changes.map((change) => (
              <li key={change.path} className="flex gap-2 text-mono-sm text-foreground/75">
                <span
                  className={cn(
                    "w-3 shrink-0",
                    change.status === "deleted"
                      ? "text-destructive"
                      : change.status === "modified"
                        ? "text-brand-readable"
                        : "text-success",
                  )}
                >
                  {CHANGE_MARK[change.status]}
                </span>
                <span className="truncate">{change.path}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {onDefault ? (
        <Field
          label="New branch"
          hint={`You're on ${status.branch ?? "a detached HEAD"}. Leave empty to commit there; a pull request needs a branch.`}
        >
          <input
            className={inputClass}
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
        </Field>
      ) : null}

      {changes > 0 ? (
        <Field
          label="Commit message"
          hint="Commits every change above, with your git identity. Hooks run."
        >
          <textarea
            className={cn(inputClass, "h-auto min-h-16 py-2 [field-sizing:content]")}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
      ) : null}

      {status.remote ? (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              className="size-3.5 accent-brand"
              checked={push || willPr}
              disabled={willPr}
              onChange={(event) => setPush(event.target.checked)}
            />
            Push to origin
          </label>
          {canPr ? (
            <label
              className={cn("flex items-center gap-2 text-body-sm", !prPossible && "opacity-50")}
            >
              <input
                type="checkbox"
                className="size-3.5 accent-brand"
                checked={willPr}
                disabled={!prPossible}
                onChange={(event) => setOpenPr(event.target.checked)}
              />
              Open a pull request
              {!prPossible ? (
                <span className="text-caption text-foreground/45">(needs a branch)</span>
              ) : null}
            </label>
          ) : (status.gh === "missing" || status.gh === "signed-out") && !status.pr ? (
            <p className="text-caption text-foreground/45">
              {status.gh === "missing" ? "Install the GitHub CLI (gh)" : "Run `gh auth login`"} to
              open pull requests from here.
            </p>
          ) : null}
        </div>
      ) : null}

      {willPr ? (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <Field label="Pull request title">
            <input
              className={inputClass}
              value={prTitle}
              onChange={(event) => setPrTitle(event.target.value)}
            />
          </Field>
          <Field label="Description">
            <textarea
              className={cn(inputClass, "h-auto max-h-60 min-h-24 py-2 [field-sizing:content]")}
              value={prBody}
              onChange={(event) => setPrBody(event.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              className="size-3.5 accent-brand"
              checked={draft}
              onChange={(event) => setDraft(event.target.checked)}
            />
            Open as a draft
          </label>
        </div>
      ) : null}

      {error ? (
        <pre className="whitespace-pre-wrap text-caption text-destructive">{error}</pre>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={nothing || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />} {label}
        </Button>
      </div>
    </form>
  );
}
