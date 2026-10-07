import type { Project, Thread } from "@agentplane/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderGit2, Inbox, Moon, Plus, Search, Settings, Sun, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { client } from "~/lib/client.ts";
import { relativeTime } from "~/lib/format.ts";
import { threadsByProject, unseenFinished, useAgentLabel, useApp } from "~/lib/store.ts";
import { openDialog, setPalette, toggleTheme, useUi } from "~/lib/ui.ts";
import { Button, Eyebrow, Kbd, StatusDot } from "./ui.tsx";

export function Sidebar() {
  const projects = useApp((state) => state.projects);
  const threads = useApp((state) => state.threads);
  const theme = useUi((state) => state.theme);

  const byProject = useMemo(() => threadsByProject({ threads }), [threads]);

  const waiting = Object.values(threads).filter((t) => t.status === "needs-input").length;
  const working = Object.values(threads).filter((t) => t.status === "running").length;

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r bg-panel">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <Link to="/" className="flex items-center gap-2">
          <Logo />
          <span className="text-body-sm">agentplane</span>
        </Link>
        <div className="flex items-center gap-0.5">
          <Link
            to="/settings"
            aria-label="Settings"
            title="Settings · Composio"
            className="inline-flex size-7 items-center justify-center rounded-md text-foreground/70 hover:bg-foreground/5 hover:text-foreground [&_svg]:size-4"
            activeProps={{ className: "bg-foreground/[0.07] text-foreground" }}
          >
            <Settings />
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            title="Toggle theme"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      <button
        type="button"
        onClick={() => setPalette(true)}
        className="mx-3 mt-3 flex cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-left text-body-sm text-foreground/45 hover:text-foreground/70"
      >
        <Search className="size-3.5" />
        <span className="flex-1">Search</span>
        <Kbd>⌘K</Kbd>
      </button>
      <InboxLink />
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <Eyebrow className="flex items-center gap-1.5">
          <StatusDot status={waiting > 0 ? "needs-input" : "idle"} /> {waiting} waiting
        </Eyebrow>
        <Eyebrow className="flex items-center gap-1.5">
          <StatusDot status={working > 0 ? "running" : "idle"} /> {working} working
        </Eyebrow>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        <div className="flex items-center justify-between px-4 py-1.5">
          <Eyebrow>Projects</Eyebrow>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add project"
            title="Add project"
            onClick={() => openDialog({ kind: "add-project" })}
          >
            <Plus />
          </Button>
        </div>
        {projects.length === 0 ? (
          <p className="px-4 py-2 text-caption text-foreground/45">
            Add a folder to start running agents in it.
          </p>
        ) : (
          projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              threads={byProject.get(project.id) ?? []}
            />
          ))
        )}
      </nav>
    </aside>
  );
}

function InboxLink() {
  const waiting = useApp(
    (state) =>
      Object.values(state.threads).filter((thread) => thread.status === "needs-input").length,
  );
  const finished = useApp((state) => unseenFinished(state).length);
  return (
    <Link
      to="/inbox"
      className="mx-3 mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-body-sm text-foreground/70 hover:bg-foreground/5 hover:text-foreground"
      activeProps={{ className: "bg-foreground/[0.07] text-foreground" }}
    >
      <Inbox className="size-3.5" />
      <span className="flex-1">Inbox</span>
      {waiting > 0 ? (
        <span className="rounded-xs bg-warning px-1.5 text-mono-xs text-warning-foreground">
          {waiting}
        </span>
      ) : null}
      {finished > 0 ? (
        <span className="rounded-xs border px-1.5 text-mono-xs text-foreground/55">{finished}</span>
      ) : null}
    </Link>
  );
}

function ProjectGroup({ project, threads }: { project: Project; threads: Thread[] }) {
  const navigate = useNavigate();
  const remove = async () => {
    const ok = confirm(
      `Remove ${project.name} and its ${threads.length} thread(s) from Agentplane? Files and worktrees on disk are left alone.`,
    );
    if (!ok) return;
    await client.request("project.delete", { projectId: project.id });
    await navigate({ to: "/" });
  };

  return (
    <section className="mt-1">
      <div className="group flex items-center gap-2 px-4 py-1.5">
        <FolderGit2 className="size-3.5 shrink-0 text-foreground/40" />
        <span
          className="min-w-0 flex-1 truncate text-body-sm text-foreground/80"
          title={project.path}
        >
          {project.name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 opacity-0 group-hover:opacity-100"
          aria-label={`Remove ${project.name}`}
          onClick={remove}
        >
          <Trash2 className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`New thread in ${project.name}`}
          title="New thread"
          onClick={() => openDialog({ kind: "new-thread", projectId: project.id })}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <ul>
        {threads.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} />
        ))}
      </ul>
    </section>
  );
}

function ThreadRow({ thread }: { thread: Thread }) {
  const agent = useAgentLabel(thread.provider);
  return (
    <li>
      <Link
        to="/t/$threadId"
        params={{ threadId: thread.id }}
        className="mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-foreground/70 hover:bg-foreground/5 hover:text-foreground"
        activeProps={{ className: "bg-foreground/[0.07] text-foreground" }}
      >
        <StatusDot status={thread.status} />
        <span className="min-w-0 flex-1 truncate text-body-sm">{thread.title}</span>
        <span className="max-w-24 truncate text-mono-xs text-foreground/35 uppercase">
          {agent} · {relativeTime(thread.createdAt)}
        </span>
      </Link>
    </li>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      <rect x="1" y="1" width="6" height="6" className="fill-brand-readable" />
      <rect x="9" y="1" width="6" height="6" className="fill-foreground/85" />
      <rect x="1" y="9" width="6" height="6" className="fill-foreground/85" />
      <rect x="9" y="9" width="6" height="6" className="fill-foreground/30" />
    </svg>
  );
}
