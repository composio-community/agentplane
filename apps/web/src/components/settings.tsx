import {
  type Automation,
  type ComposioStatus,
  describeRule,
  type PermissionRule,
  type ProviderKeysStatus,
} from "@agentplane/contracts";
import { useRouter } from "@tanstack/react-router";
import { FlaskConical, Plug, Trash2, Zap } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { client, refreshAgentStatuses } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { RUNTIME_MODES, relativeTime } from "~/lib/format.ts";
import { useApp } from "~/lib/store.ts";
import { NewAutomation } from "./automation-form.tsx";
import { Field, inputClass } from "./modal.tsx";
import { Button, Chip, Eyebrow } from "./ui.tsx";

export type SettingsData = {
  keys: ProviderKeysStatus;
  status: ComposioStatus;
  automations: Automation[];
  rules: PermissionRule[];
};

export async function loadSettings(): Promise<SettingsData> {
  const [keys, status, automations, rules] = await Promise.all([
    client.request("keys.status", {}),
    client.request("composio.status", {}),
    client.request("automations.list", {}),
    client.request("rules.list", {}),
  ]);
  return { keys, status, automations, rules };
}

const POPULAR_TOOLKITS = ["linear", "github", "sentry", "slack", "jira", "gmail"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a mutation, then reload the route's data. */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      await router.invalidate();
      return result;
    } catch (err) {
      setError(errorText(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function SettingsPage({ data }: { data: SettingsData }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-prose flex-col gap-10 px-6 py-10">
        <header className="flex flex-col gap-2">
          <Eyebrow tone="brand">Settings</Eyebrow>
          <h1 className="text-h2">Models</h1>
          <p className="text-body-sm text-foreground/55">
            Claude Code and Codex use their own sign-in. With an OpenRouter key, OpenCode, Pi and
            other open agents can run any model without one.
          </p>
        </header>
        <KeysSection keys={data.keys} />
        <header className="flex flex-col gap-2 border-t pt-10">
          <h2 className="text-h2">Composio</h2>
          <p className="text-body-sm text-foreground/55">
            Give every agent the same tools for GitHub, Linear, Slack, Sentry and 1000+ other apps,
            and let events in those apps start threads on their own.
          </p>
        </header>
        <ComposioSection status={data.status} />
        <AutomationsSection status={data.status} automations={data.automations} />
        <RulesSection rules={data.rules} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  );
}

function KeysSection({ keys }: { keys: ProviderKeysStatus }) {
  const [key, setKey] = useState("");
  const { busy, error, run } = useAction();
  const openrouter = keys.openrouter;
  const configure = (value: string | null) =>
    void run(() => client.request("keys.configure", { openrouter: value })).then((result) => {
      if (!result) return;
      setKey("");
      // Agents that run on the key are ready now (and list its models).
      void refreshAgentStatuses().catch(() => undefined);
    });

  return (
    <Section title="OpenRouter">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        {openrouter.configured ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-block size-2 rounded-full bg-success" />
            <span className="text-body-sm">Connected</span>
            <Chip>{openrouter.preview}</Chip>
            <span className="text-caption text-foreground/45">
              {openrouter.source === "env" ? "from OPENROUTER_API_KEY" : "saved on this machine"}
            </span>
            {openrouter.source === "settings" ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={busy}
                onClick={() => configure(null)}
              >
                Remove key
              </Button>
            ) : null}
          </div>
        ) : null}
        {openrouter.agents.length > 0 ? (
          <p className="text-caption text-foreground/50">
            Runs {openrouter.agents.join(", ")}. Pick a model in a thread's model menu.
          </p>
        ) : null}
        {openrouter.source !== "env" ? (
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              configure(key.trim());
            }}
            className={cn("flex flex-col gap-2", openrouter.configured && "border-t pt-4")}
          >
            <Field
              label={openrouter.configured ? "Replace key" : "API key"}
              hint="From openrouter.ai/settings/keys. Checked with OpenRouter, stored only on this machine, and handed to agents in their environment, never on a command line."
            >
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                  placeholder="sk-or-…"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
                <Button type="submit" variant="primary" disabled={busy || key.trim().length < 8}>
                  Save
                </Button>
              </div>
            </Field>
          </form>
        ) : null}
        {error ? <p className="text-caption text-destructive">{error}</p> : null}
      </div>
    </Section>
  );
}

function ComposioSection({ status }: { status: ComposioStatus }) {
  const [key, setKey] = useState("");
  const [toolkit, setToolkit] = useState("");
  const [connectMessage, setConnectMessage] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(() => client.request("composio.configure", { apiKey: key.trim() })).then((result) => {
      if (result) setKey("");
    });
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setConnectMessage(null);
    const result = await run(() => client.request("composio.connect", { toolkit: toolkit.trim() }));
    if (!result) return;
    if (result.connected) setConnectMessage(`${toolkit} is already connected.`);
    else if (result.url) window.open(result.url, "_blank", "noopener");
  };

  return (
    <Section title="Account">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        {status.configured ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-block size-2 rounded-full bg-success" />
            <span className="text-body-sm">Connected</span>
            <Chip>{status.keyPreview}</Chip>
            <span className="text-caption text-foreground/45">
              {status.keySource === "env" ? "from COMPOSIO_API_KEY" : "saved on this machine"}
            </span>
            {status.keySource === "settings" ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={busy}
                onClick={() =>
                  void run(() => client.request("composio.configure", { apiKey: null }))
                }
              >
                Remove key
              </Button>
            ) : null}
          </div>
        ) : (
          <form onSubmit={save} className="flex flex-col gap-2">
            <Field
              label="API key"
              hint="From platform.composio.dev → Settings → API keys. It's stored only on this machine and never sent to the browser again."
            >
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  className={inputClass}
                  placeholder="ak_…"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
                <Button type="submit" variant="primary" disabled={busy || key.trim().length < 8}>
                  Save
                </Button>
              </div>
            </Field>
          </form>
        )}

        <label
          className={cn(
            "flex cursor-pointer items-start gap-3 border-t pt-4",
            !status.configured && "cursor-not-allowed opacity-50",
          )}
        >
          <input
            type="checkbox"
            className="mt-1 accent-brand"
            checked={status.toolsEnabled}
            disabled={!status.configured || busy}
            onChange={(event) =>
              void run(() =>
                client.request("composio.configure", { toolsEnabled: event.target.checked }),
              )
            }
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-body-sm">Give every agent Composio tools</span>
            <span className="text-caption text-foreground/50">
              Claude, Codex and ACP agents get one MCP server with search over 1000+ apps. The first
              time an agent needs an app, it shows you a link to connect it. Applies to new
              sessions.
            </span>
          </span>
        </label>

        {status.configured ? (
          <form onSubmit={connect} className="flex flex-col gap-2 border-t pt-4">
            <Eyebrow>Connect an app</Eyebrow>
            <div className="flex gap-2">
              <input
                className={inputClass}
                placeholder="linear, github, sentry…"
                value={toolkit}
                onChange={(event) => setToolkit(event.target.value)}
              />
              <Button type="submit" disabled={busy || !toolkit.trim()}>
                <Plug /> Connect
              </Button>
            </div>
            <ToolkitChips onPick={setToolkit} />
            {connectMessage ? <p className="text-caption text-success">{connectMessage}</p> : null}
          </form>
        ) : null}

        {status.error ? <p className="text-caption text-warning">{status.error}</p> : null}
        {error ? <p className="text-caption text-destructive">{error}</p> : null}
      </div>
    </Section>
  );
}

function ToolkitChips({ onPick }: { onPick: (toolkit: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {POPULAR_TOOLKITS.map((toolkit) => (
        <button
          key={toolkit}
          type="button"
          onClick={() => onPick(toolkit)}
          className="cursor-pointer rounded-xs border bg-background px-1.5 py-0.5 text-mono-xs text-foreground/55 uppercase tracking-wider hover:text-foreground"
        >
          {toolkit}
        </button>
      ))}
    </div>
  );
}

function AutomationsSection({
  status,
  automations,
}: {
  status: ComposioStatus;
  automations: Automation[];
}) {
  return (
    <Section title="Automations">
      <p className="-mt-2 text-body-sm text-foreground/55">
        When something happens in a connected app, start a thread: a new Sentry issue, a Linear
        ticket assigned to you, a failing check.{" "}
        {status.configured ? (
          <span className={status.listening ? "text-success" : "text-foreground/45"}>
            {status.listening ? "Listening for events." : "Not listening (no enabled automations)."}
          </span>
        ) : (
          "Add an API key first."
        )}
      </p>
      {automations.map((automation) => (
        <AutomationCard key={automation.id} automation={automation} />
      ))}
      {status.configured ? <NewAutomation /> : null}
    </Section>
  );
}

function AutomationCard({ automation }: { automation: Automation }) {
  const project = useApp((state) => state.projects.find((p) => p.id === automation.projectId));
  const agent = useApp((state) => state.agents[automation.provider]?.label ?? automation.provider);
  const router = useRouter();
  const { busy, error, run } = useAction();
  const test = async () => {
    const thread = await run(() => client.request("automations.test", { id: automation.id }));
    if (thread) await router.navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Zap
          className={cn(
            "mt-0.5 size-4 shrink-0",
            automation.enabled ? "text-brand-readable" : "text-foreground/30",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-body-sm">{automation.name}</span>
          <span className="truncate text-mono-xs text-foreground/45 uppercase">
            {automation.toolkit} · {automation.triggerSlug}
          </span>
          <span className="text-caption text-foreground/55">
            → {agent}
            {automation.model ? ` (${automation.model})` : ""} in{" "}
            {project?.name ?? "a removed project"},{" "}
            {RUNTIME_MODES.find(
              (mode) => mode.value === automation.runtimeMode,
            )?.label.toLowerCase()}
            {automation.worktree ? ", own worktree" : ""}
          </span>
          <span className="text-caption text-foreground/40">
            {automation.firedCount === 0
              ? "Hasn't fired yet"
              : `Fired ${automation.firedCount}× · last ${relativeTime(automation.lastFiredAt ?? 0)} ago`}
          </span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-caption text-foreground/55">
          <input
            type="checkbox"
            className="accent-brand"
            checked={automation.enabled}
            disabled={busy}
            onChange={(event) =>
              void run(() =>
                client.request("automations.setEnabled", {
                  id: automation.id,
                  enabled: event.target.checked,
                }),
              )
            }
          />
          On
        </label>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void test()}>
          <FlaskConical /> Test with a sample event
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (confirm(`Delete “${automation.name}”? Its Composio trigger is removed too.`)) {
              void run(() => client.request("automations.delete", { id: automation.id }));
            }
          }}
        >
          <Trash2 /> Delete
        </Button>
      </div>
      {error ? <p className="text-caption text-destructive">{error}</p> : null}
    </div>
  );
}

function RulesSection({ rules }: { rules: PermissionRule[] }) {
  const projects = useApp((state) => state.projects);
  const { busy, run } = useAction();
  return (
    <Section title="Always allowed">
      <p className="-mt-2 text-body-sm text-foreground/55">
        Saved from “Always allow” on an approval. Every agent in that project gets these without
        asking; chained or redirected commands are never covered.
      </p>
      {rules.length === 0 ? (
        <p className="text-caption text-foreground/45">No rules yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-body-sm">{describeRule(rule)}</span>
              <span className="shrink-0 text-mono-xs text-foreground/40 uppercase">
                {projects.find((project) => project.id === rule.projectId)?.name ??
                  "removed project"}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove rule"
                disabled={busy}
                onClick={() => void run(() => client.request("rules.delete", { id: rule.id }))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
