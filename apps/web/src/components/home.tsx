import { CheckCircle2, CircleSlash, KeyRound } from "lucide-react";
import { Suspense, use } from "react";
import { agentStatuses } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { PROTOCOL_LABEL } from "~/lib/format.ts";
import { useApp } from "~/lib/store.ts";
import { openDialog } from "~/lib/ui.ts";
import { Button, Eyebrow } from "./ui.tsx";

export function Home() {
  const hasProjects = useApp((state) => state.projects.length > 0);
  return (
    <div className="flex flex-1 items-center overflow-y-auto">
      <div className="mx-auto flex w-full max-w-prose flex-col gap-8 px-6 py-16">
        <div className="flex flex-col gap-4">
          <Eyebrow tone="brand">Control plane for coding agents</Eyebrow>
          <h1 className="text-h1">Run your agents side by side.</h1>
          <p className="max-w-[560px] text-body text-foreground/60">
            Start Claude Code, Codex, Cursor, Gemini, Pi and dozens more agents on your own machine,
            each in its own git worktree. Approve what they want to do, watch them work, and get
            pinged when one needs you.
          </p>
          <div>
            <Button variant="primary" onClick={() => openDialog({ kind: "add-project" })}>
              {hasProjects ? "Add another project" : "Add a project"}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Eyebrow>Agents on this machine</Eyebrow>
          <Suspense
            fallback={
              <p className="text-caption text-foreground/45">
                Checking which agents are installed…
              </p>
            }
          >
            <Providers />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function Providers() {
  const statuses = use(agentStatuses());
  const featured = statuses
    .filter((status) => status.group === "featured")
    .sort((a, b) => Number(b.installed) - Number(a.installed));
  const fromRegistry = statuses.filter((status) => status.group === "registry").length;
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid gap-2 sm:grid-cols-2">
        {featured.map((status) => (
          <li
            key={status.provider}
            className="flex items-start gap-3 rounded-xl border bg-card p-4"
          >
            {status.installed && status.auth.state === "needs-sign-in" ? (
              <KeyRound className="mt-0.5 size-4 shrink-0 text-warning" />
            ) : status.installed ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <CircleSlash className="mt-0.5 size-4 shrink-0 text-foreground/35" />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-2">
                <span className="text-body-sm">{status.label}</span>
                <span className="text-mono-xs text-foreground/35 uppercase">
                  {PROTOCOL_LABEL[status.protocol]}
                </span>
              </span>
              <span
                className={cn(
                  "truncate text-mono-xs text-foreground/45",
                  status.auth.state === "needs-sign-in" && "text-warning",
                )}
                title={status.auth.detail ?? status.installHint}
              >
                {status.installed
                  ? status.auth.state === "needs-sign-in"
                    ? "Needs sign-in"
                    : status.source === "registry"
                      ? status.note
                      : (status.version ?? status.path)
                  : status.installHint}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {fromRegistry > 0 ? (
        <p className="text-caption text-foreground/45">
          Plus {fromRegistry} more from the ACP registry, available when you start a thread.
        </p>
      ) : null}
    </div>
  );
}
