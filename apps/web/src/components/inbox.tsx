import type { Thread } from "@agentplane/contracts";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Inbox as InboxIcon } from "lucide-react";
import { useMemo } from "react";
import { relativeTime } from "~/lib/format.ts";
import { markSeen, unseenFinished, useAgentLabel, useApp, waitingRequests } from "~/lib/store.ts";
import { TimelineItem } from "./items.tsx";
import { Button, Eyebrow, Kbd, STATUS_LABEL, StatusDot } from "./ui.tsx";

/**
 * Everything that needs you, across every thread: requests to answer first,
 * then work that finished since you last looked.
 */
export function Inbox() {
  const threads = useApp((state) => state.threads);
  const details = useApp((state) => state.details);
  const seen = useApp((state) => state.seen);

  const waiting = useMemo(() => waitingRequests({ threads, details }), [threads, details]);
  const finished = useMemo(() => unseenFinished({ threads, seen }), [threads, seen]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-prose flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-2">
          <Eyebrow tone="brand">Inbox</Eyebrow>
          <h1 className="text-h2">What needs you</h1>
          <p className="text-body-sm text-foreground/55">
            Requests from every agent, oldest first. <Kbd>A</Kbd> approves and <Kbd>D</Kbd> denies
            the top approval.
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <Eyebrow>Waiting on you · {waiting.length}</Eyebrow>
          {waiting.length === 0 ? (
            <p className="flex items-center gap-2 text-body-sm text-foreground/45">
              <CheckCircle2 className="size-4 text-success" /> Nothing is waiting.
            </p>
          ) : (
            waiting.map(({ thread, request }) => (
              <div key={`${thread.id}:${request.id}`} className="flex flex-col gap-2">
                <ThreadLink thread={thread} />
                <TimelineItem item={request} cwd={thread.cwd} />
              </div>
            ))
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Eyebrow>Finished since you looked · {finished.length}</Eyebrow>
            {finished.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  for (const thread of finished) markSeen(thread.id);
                }}
              >
                Mark all seen
              </Button>
            ) : null}
          </div>
          {finished.length === 0 ? (
            <p className="flex items-center gap-2 text-body-sm text-foreground/45">
              <InboxIcon className="size-4" /> You're caught up.
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border bg-card">
              {finished.map((thread) => (
                <li key={thread.id}>
                  <FinishedRow thread={thread} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function ThreadLink({ thread }: { thread: Thread }) {
  const agent = useAgentLabel(thread.provider);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: thread.id }}
      className="flex items-center gap-2 text-body-sm text-foreground/70 hover:text-foreground"
    >
      <StatusDot status={thread.status} />
      <span className="truncate">{thread.title}</span>
      <span className="shrink-0 text-mono-xs text-foreground/40 uppercase">{agent}</span>
    </Link>
  );
}

function FinishedRow({ thread }: { thread: Thread }) {
  const agent = useAgentLabel(thread.provider);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: thread.id }}
      className="flex items-center gap-3 px-4 py-3 hover:bg-foreground/[0.03]"
    >
      <StatusDot status={thread.status} />
      <span className="min-w-0 flex-1 truncate text-body-sm">{thread.title}</span>
      <span className="shrink-0 text-mono-xs text-foreground/40 uppercase">
        {thread.status === "error" ? STATUS_LABEL.error : "Done"} · {agent} ·{" "}
        {relativeTime(thread.updatedAt)}
      </span>
    </Link>
  );
}
