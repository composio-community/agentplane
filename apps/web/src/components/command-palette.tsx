import type { RuntimeMode, ThreadStatus } from "@agentplane/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CornerDownLeft, Search } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { client } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { RUNTIME_MODES } from "~/lib/format.ts";
import { currentThreadId } from "~/lib/keys.ts";
import { orderedThreads, useApp } from "~/lib/store.ts";
import { isTerminalOpen, terminalsAvailable, toggleTerminal } from "~/lib/terminal-state.ts";
import { openDialog, setPalette, toggleTheme, useUi } from "~/lib/ui.ts";
import { Eyebrow, Kbd, StatusDot } from "./ui.tsx";

type Command = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  status?: ThreadStatus;
  keywords?: string;
  run: () => void;
};

/** Subsequence match; lower is better, null is no match. */
function score(query: string, text: string): number | null {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at >= 0) return at === 0 ? 0 : 1 + at / 100;
  let position = -1;
  let gaps = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, position + 1);
    if (next < 0) return null;
    gaps += next - position - 1;
    position = next;
  }
  return 10 + gaps;
}

export function CommandPalette() {
  const open = useUi((state) => state.palette);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const navigate = useNavigate();
  const projects = useApp((state) => state.projects);
  const threads = useApp((state) => state.threads);
  const agents = useApp((state) => state.agents);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const close = () => setPalette(false);

  const commands = useMemo<Command[]>(() => {
    const currentId = currentThreadId();
    const current = currentId ? threads[currentId] : undefined;
    const list: Command[] = [];
    if (current && terminalsAvailable) {
      list.push({
        id: "terminal",
        group: "This thread",
        label: isTerminalOpen(current.id) ? "Hide terminal" : "Open terminal",
        hint: "⌘J",
        keywords: "shell console command line",
        run: () => toggleTerminal(current.id),
      });
    }
    if (current && (current.status === "running" || current.status === "needs-input")) {
      list.push({
        id: "stop",
        group: "This thread",
        label: "Stop the agent",
        hint: "Esc",
        run: () => void client.request("thread.interrupt", { threadId: current.id }),
      });
    }
    if (current && current.status !== "running" && current.status !== "needs-input") {
      for (const agent of Object.values(agents)) {
        if (!agent.installed || agent.group !== "featured" || agent.provider === current.provider)
          continue;
        list.push({
          id: `agent:${agent.provider}`,
          group: "This thread",
          label: `Switch agent to ${agent.label}`,
          hint: "carries the conversation over",
          keywords: "harness provider handoff",
          run: () =>
            void client.request("thread.setProvider", {
              threadId: current.id,
              provider: agent.provider,
              model: null,
            }),
        });
      }
    }
    if (current) {
      for (const mode of RUNTIME_MODES) {
        list.push({
          id: `mode:${mode.value}`,
          group: "This thread",
          label: `Permissions: ${mode.label}`,
          hint: current.runtimeMode === mode.value ? "current" : mode.title,
          keywords: "mode approve",
          run: () =>
            void client.request("thread.setRuntimeMode", {
              threadId: current.id,
              runtimeMode: mode.value as RuntimeMode,
            }),
        });
      }
    }
    for (const project of projects) {
      list.push({
        id: `new:${project.id}`,
        group: "Create",
        label: `New thread in ${project.name}`,
        keywords: "create start agent",
        run: () => openDialog({ kind: "new-thread", projectId: project.id }),
      });
    }
    list.push({
      id: "add-project",
      group: "Create",
      label: "Add a project",
      keywords: "folder repo",
      run: () => openDialog({ kind: "add-project" }),
    });
    for (const thread of orderedThreads({ projects, threads })) {
      const project = projects.find((candidate) => candidate.id === thread.projectId);
      list.push({
        id: `thread:${thread.id}`,
        group: "Threads",
        label: thread.title,
        hint: `${agents[thread.provider]?.label ?? thread.provider} · ${project?.name ?? ""}`,
        status: thread.status,
        keywords: `${thread.provider} ${project?.name ?? ""} ${thread.branch ?? ""}`,
        run: () => void navigate({ to: "/t/$threadId", params: { threadId: thread.id } }),
      });
    }
    list.push({
      id: "inbox",
      group: "App",
      label: "Inbox · what needs you",
      keywords: "approvals waiting finished",
      run: () => void navigate({ to: "/inbox" }),
    });
    list.push({
      id: "settings",
      group: "App",
      label: "Settings · Composio & automations",
      keywords: "composio tools triggers api key",
      run: () => void navigate({ to: "/settings" }),
    });
    list.push({ id: "theme", group: "App", label: "Toggle light / dark", run: toggleTheme });
    return list;
  }, [projects, threads, agents, navigate]);

  const results = useMemo(() => {
    const scored = commands.flatMap((command) => {
      const value = score(query.trim(), `${command.label} ${command.keywords ?? ""}`);
      return value === null ? [] : [{ command, value }];
    });
    // Keep group order when browsing; rank by match when searching.
    if (query.trim()) scored.sort((a, b) => a.value - b.value);
    return scored.map((entry) => entry.command).slice(0, 60);
  }, [commands, query]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((index) => (index + step + results.length) % Math.max(results.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[selected]);
    }
  };

  let lastGroup = "";
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog.
    <dialog
      ref={(element) => {
        if (element && !element.open) element.showModal();
      }}
      onClose={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="mx-auto mt-[12vh] w-[min(600px,calc(100vw-32px))] rounded-xl border bg-card p-0 text-foreground shadow-elevated backdrop:bg-black/40"
    >
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-4 shrink-0 text-foreground/40" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search threads and actions…"
          className="h-12 w-full bg-transparent text-body outline-none placeholder:text-foreground/35"
        />
        <Kbd>esc</Kbd>
      </div>
      <ul className="max-h-[50vh] overflow-y-auto py-2">
        {results.length === 0 ? (
          <li className="px-4 py-6 text-center text-body-sm text-foreground/45">
            Nothing matches.
          </li>
        ) : (
          results.map((command, index) => {
            // Ranked results mix groups, so headers only make sense while browsing.
            const header: ReactNode =
              !query.trim() && command.group !== lastGroup ? (
                <Eyebrow className="block px-4 pt-2 pb-1">{command.group}</Eyebrow>
              ) : null;
            lastGroup = command.group;
            return (
              <li key={command.id}>
                {header}
                <button
                  type="button"
                  onMouseMove={() => setSelected(index)}
                  onClick={() => run(command)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left",
                    index === selected ? "bg-foreground/[0.07]" : "",
                  )}
                >
                  {command.status ? <StatusDot status={command.status} /> : null}
                  <span className="min-w-0 flex-1 truncate text-body-sm">{command.label}</span>
                  {command.hint ? (
                    <span className="max-w-56 shrink-0 truncate text-mono-xs text-foreground/40 uppercase">
                      {command.hint}
                    </span>
                  ) : null}
                  {index === selected ? (
                    <CornerDownLeft className="size-3.5 shrink-0 text-foreground/40" />
                  ) : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </dialog>
  );
}
