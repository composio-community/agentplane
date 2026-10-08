import {
  DEFAULT_AUTOMATION_PROMPT,
  type RuntimeMode,
  type TriggerToolkit,
  type TriggerType,
} from "@agentplane/contracts";
import { useRouter } from "@tanstack/react-router";
import { Check, ExternalLink, Plug, RotateCw, Zap } from "lucide-react";
import { type FormEvent, Suspense, use, useRef, useState } from "react";
import { agentStatuses, client } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { RUNTIME_MODES } from "~/lib/format.ts";
import { useApp } from "~/lib/store.ts";
import { composioToolkits } from "~/lib/toolkits.ts";
import { type DropdownOption, Select } from "./dropdown.tsx";
import { Field, inputClass } from "./modal.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { Button, Segmented } from "./ui.tsx";

type Schema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  examples?: unknown[];
  items?: Schema;
  anyOf?: Schema[];
};

/** Only apps that can start a thread. */
function triggerToolkits(): Promise<TriggerToolkit[]> {
  return composioToolkits().then((list) => list.filter((toolkit) => toolkit.triggers > 0));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Set up an automation: pick an app (and connect it), a trigger, its settings
 * (a form from the trigger's schema), where it runs, and what the agent is told.
 */
export function NewAutomation() {
  return (
    <details className="group rounded-xl border border-dashed bg-background">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-body-sm text-foreground/65 hover:text-foreground">
        <Zap className="size-4" /> New automation
      </summary>
      <div className="border-t px-4 py-4">
        <Suspense fallback={<p className="text-caption text-foreground/45">Loading apps…</p>}>
          <AutomationForm />
        </Suspense>
      </div>
    </details>
  );
}

function AutomationForm() {
  const router = useRouter();
  const toolkits = use(triggerToolkits());
  const projects = useApp((state) => state.projects);
  const [toolkit, setToolkit] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [triggers, setTriggers] = useState<TriggerType[] | null>(null);
  const [triggerSlug, setTriggerSlug] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("auto-edit");
  const [worktree, setWorktree] = useState(true);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_AUTOMATION_PROMPT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const app = toolkits.find((entry) => entry.slug === toolkit);
  const trigger = triggers?.find((entry) => entry.slug === triggerSlug);

  const checkConnection = async (slug: string) => {
    setConnected(null);
    try {
      setConnected((await client.request("composio.connection", { toolkit: slug })).connected);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const pickTrigger = (next: TriggerType | undefined, appName = app?.name ?? toolkit) => {
    setTriggerSlug(next?.slug ?? "");
    setConfig(defaults(next?.config as Schema | undefined));
    setName(next ? `${appName}: ${next.name}` : "");
  };

  const pickApp = async (slug: string) => {
    setToolkit(slug);
    setTriggers(null);
    pickTrigger(undefined);
    setError(null);
    void checkConnection(slug);
    try {
      const list = await client.request("composio.triggerTypes", { toolkit: slug });
      setTriggers(list);
      // Only one to choose from: choose it. Otherwise the user picks.
      if (list.length === 1) {
        pickTrigger(list[0], toolkits.find((entry) => entry.slug === slug)?.name ?? slug);
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  const connect = async () => {
    setError(null);
    try {
      const result = await client.request("composio.connect", { toolkit });
      if (result.connected) setConnected(true);
      else if (result.url) window.open(result.url, "_blank", "noopener");
    } catch (err) {
      setError(errorText(err));
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const missing = missingRequired(trigger?.config as Schema | undefined, config);
    if (missing.length > 0) {
      setError(`Fill in ${missing.join(", ")}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.request("automations.create", {
        name: name.trim() || trigger?.name || triggerSlug,
        toolkit,
        triggerSlug,
        triggerConfig: config,
        projectId,
        provider,
        model,
        runtimeMode,
        worktree,
        prompt,
      });
      setToolkit("");
      setTriggers(null);
      pickTrigger(undefined);
      await router.invalidate();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const insertField = (token: string) => {
    const area = promptRef.current;
    const at = area?.selectionStart ?? prompt.length;
    setPrompt(`${prompt.slice(0, at)}${token}${prompt.slice(area?.selectionEnd ?? at)}`);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  return (
    <form onSubmit={(event) => void create(event)} className="flex flex-col gap-5">
      <Field label="When something happens in">
        <Select
          label="App"
          placeholder="Choose an app"
          value={toolkit}
          options={toolkits.map((entry) => ({
            value: entry.slug,
            label: entry.name,
            hint: `${entry.triggers} trigger${entry.triggers === 1 ? "" : "s"}`,
          }))}
          onChange={(slug) => void pickApp(slug)}
        />
      </Field>

      {toolkit ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-caption">
          {connected === null ? (
            <span className="text-foreground/45">
              Checking your {app?.name ?? toolkit} connection…
            </span>
          ) : connected ? (
            <span className="flex items-center gap-1.5 text-success">
              <Check className="size-3.5" /> {app?.name ?? toolkit} is connected
            </span>
          ) : (
            <>
              <span className="text-warning">
                {app?.name ?? toolkit} isn't connected. Triggers run on your account.
              </span>
              <Button size="sm" variant="primary" onClick={() => void connect()}>
                <Plug /> Connect {app?.name ?? toolkit}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void checkConnection(toolkit)}>
                <RotateCw /> I've connected it
              </Button>
            </>
          )}
        </div>
      ) : null}

      {triggers && triggers.length > 0 ? (
        <>
          <Field label="Trigger" hint={trigger?.instructions || trigger?.description}>
            <Select
              label="Trigger"
              placeholder="Choose what starts a thread"
              value={triggerSlug}
              options={triggers.map((entry) => ({
                value: entry.slug,
                label: entry.name,
                description: entry.description || entry.slug,
              }))}
              onChange={(slug) => pickTrigger(triggers.find((entry) => entry.slug === slug))}
            />
          </Field>

          {trigger ? (
            <>
              <TriggerSettings
                key={triggerSlug}
                schema={trigger?.config as Schema | undefined}
                value={config}
                onChange={setConfig}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Project">
                  <Select
                    label="Project"
                    value={projectId}
                    placeholder="Add a project first"
                    options={projects.map((project) => ({
                      value: project.id,
                      label: project.name,
                      description: project.path,
                      code: true,
                    }))}
                    onChange={setProjectId}
                  />
                </Field>
                <Field label="Agent">
                  <Suspense fallback={<div className={inputClass} />}>
                    <AgentChoice
                      value={provider}
                      onChange={(next) => {
                        setProvider(next);
                        setModel(null);
                      }}
                    />
                  </Suspense>
                </Field>
              </div>
              <Field label="Model">
                <ModelPicker key={provider} provider={provider} value={model} onChange={setModel} />
              </Field>
              <Field label="Permissions" group>
                <Segmented
                  value={runtimeMode}
                  onChange={setRuntimeMode}
                  options={RUNTIME_MODES}
                  className="self-start"
                />
              </Field>
              <label className="-mt-2 flex cursor-pointer items-center gap-2 text-body-sm">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={worktree}
                  onChange={(event) => setWorktree(event.target.checked)}
                />
                Run each event in its own git worktree
              </label>

              <Field label="Name">
                <input
                  className={inputClass}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field
                label="What the agent is told"
                hint="Click a field to insert it. {{payload}} is the whole event as JSON."
              >
                <textarea
                  ref={promptRef}
                  className={cn(inputClass, "h-40 py-2")}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
                <PayloadFields
                  schema={trigger?.payload as Schema | undefined}
                  onPick={insertField}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !projectId || !triggerSlug || connected === false}
                >
                  {busy ? "Creating…" : "Create automation"}
                </Button>
                <a
                  className="inline-flex items-center gap-1 text-caption text-foreground/50 hover:text-foreground"
                  href="https://docs.composio.dev/docs/triggers"
                  target="_blank"
                  rel="noreferrer"
                >
                  How triggers work <ExternalLink className="size-3" />
                </a>
              </div>
            </>
          ) : null}
        </>
      ) : toolkit && triggers ? (
        <p className="text-caption text-foreground/50">This app has no triggers.</p>
      ) : null}
      {error ? <p className="text-caption text-destructive">{error}</p> : null}
    </form>
  );
}

function AgentChoice({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const agents = use(agentStatuses()).filter((agent) => agent.installed);
  return (
    <Select
      label="Agent"
      value={value}
      options={agents.map((agent) => ({
        value: agent.provider,
        label: agent.label,
        hint: agent.auth.state === "needs-sign-in" ? "Sign in" : null,
        group: agent.group === "featured" ? "Agents" : "ACP registry",
      }))}
      onChange={onChange}
    />
  );
}

/** The non-null variant of an anyOf (Pydantic's optional fields). */
function resolved(schema: Schema): Schema {
  return schema.anyOf?.find((option) => option.type !== "null") ?? schema;
}

const typeOf = (schema: Schema) =>
  Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type;

/** Starting values: each field's default. */
function defaults(schema: Schema | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema?.properties ?? {}).flatMap(([key, field]) =>
      field.default !== undefined && field.default !== null ? [[key, field.default]] : [],
    ),
  );
}

function missingRequired(schema: Schema | undefined, value: Record<string, unknown>): string[] {
  return (schema?.required ?? [])
    .filter((key) => value[key] === undefined || value[key] === "")
    .map((key) => schema?.properties?.[key]?.title ?? key);
}

/** The trigger's settings as a form, built from its JSON Schema. */
function TriggerSettings({
  schema,
  value,
  onChange,
}: {
  schema: Schema | undefined;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const fields = Object.entries(schema?.properties ?? {});
  if (fields.length === 0) {
    return <p className="-mt-2 text-caption text-foreground/45">No settings needed.</p>;
  }
  const required = new Set(schema?.required ?? []);
  const set = (key: string, next: unknown) => {
    const copy = { ...value };
    if (next === undefined || next === "") delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map(([key, raw]) => {
        const field = resolved(raw);
        const label = `${raw.title ?? field.title ?? key}${required.has(key) ? " *" : ""}`;
        const hint = raw.description ?? field.description;
        const type = typeOf(field);
        const current = value[key];
        const example = field.examples?.[0] ?? raw.examples?.[0];
        if (field.enum?.length) {
          const options: DropdownOption[] = field.enum.map((option) => ({
            value: String(option),
            label: String(option),
          }));
          return (
            <Field key={key} label={label} hint={hint}>
              <Select
                label={label}
                value={current === undefined ? "" : String(current)}
                options={options}
                onChange={(next) => set(key, next)}
              />
            </Field>
          );
        }
        if (type === "boolean") {
          return (
            <label
              key={key}
              className="flex cursor-pointer items-start gap-2 self-end text-body-sm"
            >
              <input
                type="checkbox"
                className="mt-1 accent-brand"
                checked={current === true}
                onChange={(event) => set(key, event.target.checked)}
              />
              <span className="flex flex-col">
                {label}
                {hint ? <span className="text-caption text-foreground/45">{hint}</span> : null}
              </span>
            </label>
          );
        }
        const numeric = type === "integer" || type === "number";
        const list = type === "array";
        return (
          <Field
            key={key}
            label={label}
            hint={list ? `${hint ?? ""} Separate with commas.`.trim() : hint}
          >
            <input
              className={inputClass}
              inputMode={numeric ? "numeric" : undefined}
              placeholder={example === undefined ? undefined : String(example)}
              value={
                current === undefined
                  ? ""
                  : Array.isArray(current)
                    ? current.join(", ")
                    : String(current)
              }
              onChange={(event) => {
                const text = event.target.value;
                if (numeric) set(key, text === "" ? undefined : Number(text));
                else if (list)
                  set(
                    key,
                    text
                      .split(",")
                      .map((part) => part.trim())
                      .filter(Boolean),
                  );
                else set(key, text);
              }}
            />
          </Field>
        );
      })}
    </div>
  );
}

/** The event's fields as chips that insert `{{payload.field}}` into the prompt. */
function PayloadFields({
  schema,
  onPick,
}: {
  schema: Schema | undefined;
  onPick: (token: string) => void;
}) {
  const fields = Object.entries(schema?.properties ?? {}).slice(0, 24);
  const tokens = [
    ...fields.map(([key, field]) => ({
      token: `{{payload.${key}}}`,
      title: field.description ?? field.title ?? key,
      label: key,
    })),
    { token: "{{payload}}", title: "The whole event as JSON", label: "whole event" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {tokens.map(({ token, title, label }) => (
        <button
          key={token}
          type="button"
          title={title}
          onClick={() => onPick(token)}
          className="cursor-pointer rounded-xs border bg-card px-1.5 py-0.5 text-mono-xs text-foreground/60 hover:border-foreground/25 hover:text-foreground"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
