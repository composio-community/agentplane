import {
  type ApprovalDecision,
  describeRule,
  type Item,
  type ItemOf,
  ruleFor,
  type ToolKind,
  type Turn,
} from "@agentplane/contracts";
import {
  ArrowRightLeft,
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CornerDownLeft,
  FilePen,
  FileText,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Plug,
  RotateCw,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { client, refreshAgentStatuses } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { duration, usageLabel } from "~/lib/format.ts";
import { useAgentLabel, useApp } from "~/lib/store.ts";
import { Diff } from "./diff.tsx";
import { TurnChanges } from "./turn-changes.tsx";
import { Button, Eyebrow } from "./ui.tsx";

/** Paths inside the thread's folder read better relative to it. */
function relativize(text: string, cwd: string): string {
  return text === cwd ? "." : text.split(`${cwd}/`).join("");
}

export const TimelineItem = memo(function TimelineItem({
  item,
  cwd,
  latest = false,
}: {
  item: Item;
  cwd: string;
  /** In the thread's most recent turn, so its actions still apply. */
  latest?: boolean;
}) {
  switch (item.kind) {
    case "user_message":
      return <UserMessage item={item} />;
    case "assistant_message":
      return <AssistantMessage item={item} />;
    case "reasoning":
      return <Reasoning item={item} />;
    case "tool_call":
      return <ToolCall item={item} cwd={cwd} />;
    case "approval":
      return <Approval item={item} cwd={cwd} />;
    case "question":
      return <Question item={item} />;
    case "plan":
      return <Plan item={item} />;
    case "error":
      return item.setup ? (
        <SetupNeeded item={item} setup={item.setup} latest={latest} />
      ) : (
        <ErrorNotice item={item} />
      );
    case "notice":
      return <Notice item={item} />;
    case "handoff":
      return <HandoffDivider item={item} />;
    case "setup_request":
      return <SetupRequest item={item} />;
  }
});

function UserMessage({ item }: { item: ItemOf<"user_message"> }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-xl border bg-card px-4 py-2.5 text-body-sm">
        {item.text}
      </div>
      {item.steered ? (
        <Eyebrow className="flex items-center gap-1 text-mono-xs">
          <CornerDownLeft className="size-3" /> Sent while it worked
        </Eyebrow>
      ) : null}
    </div>
  );
}

const markdownComponents: Components = {
  // Loading a remote image is a request an agent (or a prompt injected into
  // what it read) controls, which can carry data out. Show a link instead.
  img: ({ src, alt }) =>
    typeof src === "string" && /^https?:\/\//.test(src) ? (
      <a href={src} target="_blank" rel="noreferrer">
        {alt || "image"}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  // Agents link files by absolute path; those aren't navigable from here.
  a: ({ href, children }) =>
    href && /^https?:\/\//.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <code title={href}>{children}</code>
    ),
};

function AssistantMessage({ item }: { item: ItemOf<"assistant_message"> }) {
  return (
    <div className="chat-prose">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {item.text}
      </Markdown>
      {item.streaming ? (
        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse-dot bg-brand-readable align-middle" />
      ) : null}
    </div>
  );
}

function Reasoning({ item }: { item: ItemOf<"reasoning"> }) {
  if (!item.text.trim()) return null;
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-foreground/45 hover:text-foreground/70">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        <Eyebrow className="text-inherit">{item.streaming ? "Thinking…" : "Thought"}</Eyebrow>
      </summary>
      <div className="mt-2 whitespace-pre-wrap border-l-2 pl-3 text-caption text-foreground/55">
        {item.text}
      </div>
    </details>
  );
}

const TOOL_ICONS: Record<ToolKind, typeof Wrench> = {
  command: SquareTerminal,
  file_change: FilePen,
  read: FileText,
  search: Search,
  web: Globe,
  mcp: Plug,
  subagent: Bot,
  other: Wrench,
};

function ToolCall({ item, cwd }: { item: ItemOf<"tool_call">; cwd: string }) {
  const Icon = TOOL_ICONS[item.toolKind];
  const detail = item.detail ? relativize(item.detail, cwd) : null;
  const expandable = Boolean(item.output || item.diff);
  const row = (
    <>
      <Icon className="size-3.5 shrink-0 text-foreground/45" />
      <span className="shrink-0 text-mono-sm text-foreground/80">{item.title}</span>
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-mono-sm text-foreground/45">{detail}</span>
      ) : (
        <span className="flex-1" />
      )}
      <ToolStatus status={item.status} />
    </>
  );
  if (!expandable) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-card/60 px-3 py-1.5">{row}</div>
    );
  }
  return (
    <details className="group rounded-md border bg-card/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 hover:bg-foreground/[0.03]">
        {row}
        <ChevronRight className="size-3 shrink-0 text-foreground/35 transition-transform group-open:rotate-90" />
      </summary>
      <div className="flex flex-col gap-2 border-t px-3 py-2">
        {detail && detail.length > 80 ? (
          <pre className="whitespace-pre-wrap text-mono-sm text-foreground/70">{detail}</pre>
        ) : null}
        {item.diff ? <Diff text={item.diff} /> : null}
        {item.output ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xs bg-background p-2 text-mono-sm text-foreground/65">
            {relativize(item.output, cwd)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}

function ToolStatus({ status }: { status: ItemOf<"tool_call">["status"] }) {
  if (status === "running") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-brand-readable" />;
  }
  if (status === "failed") return <X className="size-3.5 shrink-0 text-destructive" />;
  return <Check className="size-3.5 shrink-0 text-success" />;
}

function RequestCard({
  pending,
  eyebrow,
  children,
}: {
  pending: boolean;
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        pending ? "border-warning/60 bg-warning/[0.06]" : "bg-card/60",
      )}
    >
      <Eyebrow className={cn("flex items-center gap-1.5", pending && "text-warning")}>
        <ShieldAlert className="size-3.5" /> {eyebrow}
      </Eyebrow>
      {children}
    </div>
  );
}

const REQUEST_STATUS_LABEL = {
  pending: "Waiting for you",
  approved: "Approved",
  denied: "Denied",
  answered: "Answered",
  cancelled: "Cancelled",
} as const;

function Approval({ item, cwd }: { item: ItemOf<"approval">; cwd: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = item.status === "pending";

  const rule = ruleFor(item);
  const always = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.request("approval.always", { threadId: item.threadId, itemId: item.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const respond = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      await client.request("approval.respond", {
        threadId: item.threadId,
        itemId: item.id,
        decision,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (!pending) {
    return (
      <div className="flex items-center gap-2 px-1 text-caption text-foreground/45">
        <ShieldAlert className="size-3.5" />
        <span>{REQUEST_STATUS_LABEL[item.status]}:</span>
        <span className="truncate">{item.title}</span>
        {item.reason?.startsWith("Allowed by your rule") ? (
          <span className="shrink-0 text-brand-readable">
            ·{" "}
            {item.reason
              .replace(/^Allowed by your rule for /, "allowed by your rule for ")
              .replace(/ in this project\.$/, "")}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <RequestCard pending eyebrow="Approval needed">
      <p className="text-body-sm">{item.title}</p>
      {item.detail ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xs border bg-background px-3 py-2 text-mono-md">
          {relativize(item.detail, cwd)}
        </pre>
      ) : null}
      {item.diff ? <Diff text={item.diff} /> : null}
      {item.reason ? <p className="text-caption text-foreground/55">{item.reason}</p> : null}
      {error ? <p className="text-caption text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => respond("approve")}>
          <Check /> Approve
        </Button>
        {rule ? (
          <Button
            disabled={busy}
            onClick={() => void always()}
            title="Saved as a project rule; applies to every agent"
          >
            Always allow {describeRule(rule)}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => respond("approve-session")}>
            Allow for this session
          </Button>
        )}
        <Button variant="danger" disabled={busy} onClick={() => respond("deny")}>
          <X /> Deny
        </Button>
      </div>
    </RequestCard>
  );
}

function Question({ item }: { item: ItemOf<"question"> }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = item.status === "pending";

  const toggle = (question: string, label: string, multi: boolean) => {
    setSelected((current) => {
      const chosen = current[question] ?? [];
      const next = multi
        ? chosen.includes(label)
          ? chosen.filter((l) => l !== label)
          : [...chosen, label]
        : [label];
      return { ...current, [question]: next };
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const answers = Object.fromEntries(
      item.questions.map((q) => [q.question, (selected[q.question] ?? []).join(", ")]),
    );
    try {
      await client.request("question.respond", {
        threadId: item.threadId,
        itemId: item.id,
        answers,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const complete = item.questions.every((q) => (selected[q.question] ?? []).length > 0);

  return (
    <RequestCard
      pending={pending}
      eyebrow={pending ? "Question" : REQUEST_STATUS_LABEL[item.status]}
    >
      {item.questions.map((question) => (
        <fieldset key={question.question} className="flex flex-col gap-2">
          <legend className="mb-2 flex flex-col gap-1">
            {question.header ? <Eyebrow tone="brand">{question.header}</Eyebrow> : null}
            <span className="text-body-sm">{question.question}</span>
          </legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {question.options.map((option) => {
              const answered = item.answers?.[question.question]
                ?.split(", ")
                .includes(option.label);
              const chosen = pending
                ? (selected[question.question] ?? []).includes(option.label)
                : Boolean(answered);
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={!pending || busy}
                  onClick={() => toggle(question.question, option.label, question.multiSelect)}
                  className={cn(
                    "flex cursor-pointer flex-col items-start gap-0.5 rounded-md border bg-background px-3 py-2 text-left transition-colors disabled:cursor-default",
                    chosen ? "border-brand-readable/70 bg-brand/10" : "hover:border-foreground/20",
                    !pending && !chosen && "opacity-40",
                  )}
                >
                  <span className="text-body-sm">{option.label}</span>
                  {option.description ? (
                    <span className="text-caption text-foreground/50">{option.description}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      {error ? <p className="text-caption text-destructive">{error}</p> : null}
      {pending ? (
        <div>
          <Button variant="primary" disabled={busy || !complete} onClick={submit}>
            Send answer
          </Button>
        </div>
      ) : null}
    </RequestCard>
  );
}

/** A project's setup command, waiting for the user's OK before it runs (it's the repo's code). */
function SetupRequest({ item }: { item: ItemOf<"setup_request"> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (decision: "run" | "always" | "skip") => {
    setBusy(true);
    setError(null);
    try {
      await client.request("setup.respond", { threadId: item.threadId, itemId: item.id, decision });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (item.status !== "pending") {
    const label = {
      running: "Running setup",
      done: "Setup ran",
      failed: "Setup failed",
      skipped: "Setup skipped",
    }[item.status];
    const row = (
      <>
        {item.status === "running" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-brand-readable" />
        ) : item.status === "failed" ? (
          <X className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <SquareTerminal className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0">{label}:</span>
        <code className="truncate text-mono-sm">{item.command}</code>
      </>
    );
    return item.output ? (
      <details className="group text-caption text-foreground/45">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-1">
          {row}
          <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xs border bg-background p-2 text-mono-sm text-foreground/65">
          {item.output}
        </pre>
      </details>
    ) : (
      <div className="flex items-center gap-2 px-1 text-caption text-foreground/45">{row}</div>
    );
  }

  return (
    <RequestCard pending eyebrow="Worktree setup">
      <p className="text-body-sm">
        This project's <code className="text-mono-sm">agentplane.json</code> runs a command in new
        worktrees. It's the repository's code, so it waits for your OK.
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-xs border bg-background px-3 py-2 text-mono-md">
        {item.command}
      </pre>
      {error ? <p className="text-caption text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void respond("run")}>
          <Check /> Run it
        </Button>
        <Button
          disabled={busy}
          onClick={() => void respond("always")}
          title="Runs this exact command in this project's new worktrees from now on; asks again if it changes"
        >
          Always for this project
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void respond("skip")}>
          Skip
        </Button>
      </div>
    </RequestCard>
  );
}

function Plan({ item }: { item: ItemOf<"plan"> }) {
  const done = item.steps.filter((step) => step.status === "completed").length;
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card/60 p-4">
      <Eyebrow>
        Plan · {done}/{item.steps.length}
      </Eyebrow>
      <ul className="flex flex-col gap-1">
        {item.steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional.
          <li key={index} className="flex items-start gap-2 text-body-sm">
            {step.status === "completed" ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : step.status === "in_progress" ? (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-brand-readable" />
            ) : (
              <Circle className="mt-0.5 size-3.5 shrink-0 text-foreground/30" />
            )}
            <span
              className={cn(
                step.status === "completed" && "text-foreground/45 line-through",
                step.status === "in_progress" && "text-foreground",
                step.status === "pending" && "text-foreground/70",
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const HANDOFF_SCOPE = {
  full: "the thread so far",
  delta: "what it missed",
  fallback: "the thread so far (its earlier session was lost)",
} as const;

/** Where one agent took over from another, and what it was given. */
function HandoffDivider({ item }: { item: ItemOf<"handoff"> }) {
  const detail = [
    `${item.included} ${item.included === 1 ? "entry" : "entries"}`,
    item.omitted > 0 ? `${item.omitted} older left out` : null,
    item.native ? "as native history" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-3" title={`Gave ${item.to} ${HANDOFF_SCOPE[item.mode]}`}>
      <div className="h-px flex-1 bg-border" />
      <Eyebrow className="flex items-center gap-1.5 text-brand-readable">
        <ArrowRightLeft className="size-3.5" />
        {item.from.join(" + ")} → {item.to}
      </Eyebrow>
      <span className="text-mono-xs text-foreground/40 uppercase tracking-wider">
        {HANDOFF_SCOPE[item.mode]} · {detail}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Notice({ item }: { item: ItemOf<"notice"> }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-caption text-foreground/65 [&_a]:text-brand-readable [&_a]:underline">
      <Info className="mt-0.5 size-3.5 shrink-0 text-foreground/40" />
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {item.text}
      </Markdown>
    </div>
  );
}

function ErrorNotice({ item }: { item: ItemOf<"error"> }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/[0.06] px-3 py-2">
      <Eyebrow className="text-destructive">Error</Eyebrow>
      <pre className="whitespace-pre-wrap text-mono-sm text-foreground/75">{item.message}</pre>
    </div>
  );
}

/**
 * The agent can't run until the user fixes its setup. Offer the fix (sign in),
 * a retry, and agents that are ready now, instead of a dead-end error.
 */
function SetupNeeded({
  item,
  setup,
  latest,
}: {
  item: ItemOf<"error">;
  setup: NonNullable<ItemOf<"error">["setup"]>;
  latest: boolean;
}) {
  const label = useAgentLabel(setup.provider);
  const thread = useApp((state) => state.threads[item.threadId]);
  const agents = useApp((state) => state.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const idle = thread?.status !== "running" && thread?.status !== "needs-input";
  const actionable = latest && idle;
  const ready = Object.values(agents).filter(
    (agent) =>
      agent.group === "featured" &&
      agent.installed &&
      agent.auth.state === "ready" &&
      agent.provider !== setup.provider,
  );

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const signIn = () =>
    run(async () => {
      await client.request("agents.signIn", { provider: setup.provider });
      setSigningIn(true);
    });
  const retry = () =>
    run(async () => {
      await refreshAgentStatuses().catch(() => undefined);
      await client.request("thread.retry", { threadId: item.threadId });
    });
  const switchTo = (provider: string) =>
    run(async () => {
      await client.request("thread.setProvider", {
        threadId: item.threadId,
        provider,
        model: null,
      });
      await client.request("thread.retry", { threadId: item.threadId });
    });

  const Icon = setup.reason === "sign-in" ? KeyRound : Wrench;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        actionable ? "border-warning/60 bg-warning/[0.06]" : "bg-card/60",
      )}
    >
      <Eyebrow className={cn("flex items-center gap-1.5", actionable && "text-warning")}>
        <Icon className="size-3.5" />
        {label} {setup.reason === "sign-in" ? "needs you to sign in" : "needs an update"}
      </Eyebrow>
      <p className="text-body-sm text-foreground/75">{item.message}</p>
      {signingIn ? (
        <p className="text-caption text-foreground/55">
          Finish signing in in the Terminal window, then try again.
        </p>
      ) : null}
      {error ? <p className="text-caption text-destructive">{error}</p> : null}
      {actionable ? (
        <div className="flex flex-wrap gap-2">
          {setup.reason === "sign-in" && setup.canSignIn ? (
            <Button
              variant={signingIn ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => void signIn()}
            >
              <KeyRound /> Sign in to {label}
            </Button>
          ) : null}
          <Button
            variant={signingIn ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void retry()}
          >
            <RotateCw /> Try again
          </Button>
          {ready.slice(0, 2).map((agent) => (
            <Button
              key={agent.provider}
              disabled={busy}
              onClick={() => void switchTo(agent.provider)}
              title={`${agent.label} picks up this thread and gets your last message`}
            >
              <ArrowRightLeft /> Use {agent.label} instead
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const TurnFooter = memo(function TurnFooter({ turn }: { turn: Turn }) {
  if (turn.status === "running") {
    return (
      <div className="flex items-center gap-2 text-foreground/45">
        <Loader2 className="size-3.5 animate-spin text-brand-readable" />
        <Eyebrow className="text-inherit">Working</Eyebrow>
      </div>
    );
  }
  const parts = [
    turn.status === "completed" ? "Done" : turn.status === "interrupted" ? "Interrupted" : "Failed",
    turn.completedAt ? duration(turn.completedAt - turn.startedAt) : null,
    turn.usage && turn.usage.inputTokens + turn.usage.outputTokens > 0
      ? usageLabel(turn.usage)
      : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-3">
      <TurnChanges turn={turn} />
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <Eyebrow className={cn(turn.status === "failed" && "text-destructive")}>
          {parts.join(" · ")}
        </Eyebrow>
        <div className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
});
