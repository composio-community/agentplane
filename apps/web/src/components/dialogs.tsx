import type { Provider, ProviderStatus, RuntimeMode } from "@agentplane/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, FolderGit2, GitBranch } from "lucide-react";
import { type FormEvent, Suspense, use, useRef, useState } from "react";
import { agentStatuses, client, requestNotificationPermission } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { PROTOCOL_LABEL, RUNTIME_MODES } from "~/lib/format.ts";
import { useApp } from "~/lib/store.ts";
import { closeDialog, openDialog, useUi } from "~/lib/ui.ts";
import { Field, inputClass, Modal } from "./modal.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { Button, Eyebrow, Segmented } from "./ui.tsx";

export function Dialogs() {
  const dialog = useUi((state) => state.dialog);
  if (!dialog) return null;
  if (dialog.kind === "add-project") return <AddProjectDialog />;
  return <NewThreadDialog key={dialog.projectId} projectId={dialog.projectId} />;
}

function AddProjectDialog() {
  const [path, setPath] = useState("~/");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const latest = useRef(path);

  const updatePath = async (value: string) => {
    latest.current = value;
    setPath(value);
    setError(null);
    const dirs = await client.request("fs.suggestDirs", { prefix: value }).catch(() => []);
    // Ignore completions for a value the user has already typed past.
    if (latest.current === value) setSuggestions(dirs);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const project = await client.request("project.create", { path });
      openDialog({ kind: "new-thread", projectId: project.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal eyebrow="Add project" title="Point at a folder on this machine" onClose={closeDialog}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Path" hint="Agents run with this folder (or a worktree of it) as their cwd.">
          <input
            autoFocus
            className={inputClass}
            value={path}
            spellCheck={false}
            onChange={(event) => void updatePath(event.target.value)}
            onFocus={(event) => void updatePath(event.target.value)}
          />
        </Field>
        {suggestions.length > 0 ? (
          <ul className="-mt-2 max-h-48 overflow-y-auto rounded-md border bg-background py-1">
            {suggestions.map((dir) => (
              <li key={dir}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-mono-md text-foreground/75 hover:bg-foreground/5 hover:text-foreground"
                  title={dir}
                  onClick={() => void updatePath(`${dir}/`)}
                >
                  <FolderGit2 className="size-3.5 shrink-0 text-foreground/40" />
                  <span className="truncate">{dir.split("/").pop()}/</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p className="text-caption text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || path.trim().length === 0}>
            Add project
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NewThreadDialog({ projectId }: { projectId: string }) {
  const project = useApp((state) => state.projects.find((p) => p.id === projectId));
  const navigate = useNavigate();
  const [provider, setProvider] = useState<Provider>("claude");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("supervised");
  // Work in the folder the user picked; a worktree is opt-in.
  const [worktree, setWorktree] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!project) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    requestNotificationPermission();
    setBusy(true);
    setError(null);
    try {
      const thread = await client.request("thread.create", {
        projectId,
        provider,
        runtimeMode,
        worktree,
        model,
      });
      closeDialog();
      await navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal eyebrow={project.name} title="New thread" onClose={closeDialog}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Agent" group>
          <Suspense
            fallback={
              <p className="h-[52px] text-caption text-foreground/45">Checking installed agents…</p>
            }
          >
            <ProviderPicker
              value={provider}
              onChange={(next) => {
                setProvider(next);
                setModel(null);
              }}
            />
          </Suspense>
        </Field>
        <Field label="Model" group>
          <ModelPicker provider={provider} value={model} onChange={setModel} />
        </Field>
        <Field
          label="Permissions"
          group
          hint={RUNTIME_MODES.find((m) => m.value === runtimeMode)?.title}
        >
          <Segmented
            value={runtimeMode}
            onChange={setRuntimeMode}
            options={RUNTIME_MODES.map(({ value, label, title }) => ({ value, label, title }))}
            className="self-start"
          />
        </Field>
        <label
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-md border bg-background p-3",
            !project.isGitRepo && "cursor-not-allowed opacity-50",
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-brand"
            checked={worktree}
            disabled={!project.isGitRepo}
            onChange={(event) => setWorktree(event.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-body-sm">
              <GitBranch className="size-3.5" /> Isolate in a git worktree
            </span>
            <span className="text-caption text-foreground/50">
              {project.isGitRepo
                ? "Work on a copy on its own branch, so parallel agents never touch your checkout."
                : "This folder isn't a git repo."}
            </span>
          </span>
        </label>
        {error ? <p className="text-caption text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Start thread
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ProviderPicker({
  value,
  onChange,
}: {
  value: Provider;
  onChange: (provider: Provider) => void;
}) {
  const statuses = use(agentStatuses());
  const [query, setQuery] = useState("");
  // Ready agents first; the rest stay visible with how to get them.
  const byReadiness = (a: ProviderStatus, b: ProviderStatus) =>
    Number(b.installed) - Number(a.installed);
  const featured = statuses.filter((status) => status.group === "featured").sort(byReadiness);
  const registry = statuses
    .filter((status) => status.group === "registry")
    .filter((status) =>
      `${status.label} ${status.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  const selectedFromRegistry = statuses.some(
    (status) => status.provider === value && status.group === "registry",
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {featured.map((status) => (
          <AgentOption
            key={status.provider}
            status={status}
            selected={value === status.provider}
            onSelect={onChange}
          />
        ))}
      </div>
      {statuses.some((status) => status.group === "registry") ? (
        <details className="group rounded-md border bg-background" open={selectedFromRegistry}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-foreground/60 hover:text-foreground">
            <Eyebrow className="text-inherit">
              More from the ACP registry ·{" "}
              {statuses.filter((status) => status.group === "registry").length}
            </Eyebrow>
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          </summary>
          <div className="flex flex-col gap-2 border-t p-2">
            <input
              className={inputClass}
              placeholder="Search agents"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
              {registry.map((status) => (
                <AgentOption
                  key={status.provider}
                  status={status}
                  selected={value === status.provider}
                  onSelect={onChange}
                />
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function AgentOption({
  status,
  selected,
  onSelect,
}: {
  status: ProviderStatus;
  selected: boolean;
  onSelect: (provider: Provider) => void;
}) {
  const detail = !status.installed
    ? (status.note ?? "Not installed")
    : status.auth.state === "needs-sign-in"
      ? "Needs sign-in"
      : status.source === "registry"
        ? (status.note ?? "From the ACP registry")
        : (status.version ?? "Installed");
  return (
    <button
      type="button"
      disabled={!status.installed}
      title={[
        status.description,
        status.installed ? status.path : status.installHint,
        status.auth.detail,
      ]
        .filter(Boolean)
        .join("\n")}
      onClick={() => onSelect(status.provider)}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-md border bg-background px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        selected ? "border-brand-readable/70 bg-brand/10" : "hover:border-foreground/20",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="truncate text-body-sm">{status.label}</span>
        <span className="shrink-0 text-mono-xs text-foreground/35 uppercase">
          {PROTOCOL_LABEL[status.protocol]}
        </span>
      </span>
      <span
        className={cn(
          "w-full truncate text-mono-xs text-foreground/45",
          status.auth.state === "needs-sign-in" && "text-warning",
        )}
      >
        {detail}
      </span>
    </button>
  );
}
