import type { AgentModels, ModelOption } from "@agentplane/contracts";
import { RotateCw } from "lucide-react";
import { Suspense, use, useState } from "react";
import { agentModels, agentStatuses, client } from "~/lib/client.ts";
import { cn } from "~/lib/cn.ts";
import { chipTrigger, type DropdownOption, Select } from "./dropdown.tsx";
import { inputClass } from "./modal.tsx";
import { Button } from "./ui.tsx";

const OTHER = "__other__";

/** The option a stored model refers to: by id, by an alias, or by display name. */
export function findModel(models: ModelOption[], model: string | null): ModelOption | undefined {
  if (!model) return undefined;
  return models.find(
    (option) => option.id === model || option.aliases.includes(model) || option.name === model,
  );
}

/** Some agents list "default" as a model; it's the same as leaving it empty. */
function choices(models: ModelOption[]): ModelOption[] {
  return models.filter((option) => option.id !== "default");
}

function defaultLabel(option: ModelOption | undefined): string {
  if (!option) return "Default";
  return option.id === "default" ? option.name : `Default (${option.name})`;
}

/** A model in a dropdown: its name, with its id underneath when they differ. */
function modelOption(option: ModelOption): DropdownOption {
  return {
    value: option.id,
    label: option.name,
    description: option.name === option.id ? null : option.id,
    code: true,
    hint: option.isDefault ? "Default" : null,
  };
}

/**
 * Pick a model from what the agent itself reports. Empty means the agent's
 * default. If the agent can't answer (not signed in, not downloaded yet), it
 * says why and you can type a model instead.
 */
export function ModelPicker(props: {
  provider: string;
  value: string | null;
  onChange: (model: string | null) => void;
}) {
  return (
    <Suspense
      fallback={
        <div className={cn(inputClass, "flex items-center text-foreground/40")}>
          Asking the agent for its models…
        </div>
      }
    >
      <ModelPickerList key={props.provider} {...props} />
    </Suspense>
  );
}

function ModelPickerList({
  provider,
  value,
  onChange,
}: {
  provider: string;
  value: string | null;
  onChange: (model: string | null) => void;
}) {
  const [request, setRequest] = useState(() => agentModels(provider));
  const result: AgentModels = use(request);
  const [typing, setTyping] = useState(
    result.models.length === 0 || (value !== null && !findModel(result.models, value)),
  );
  const fallbackDefault = result.models.find((option) => option.isDefault);
  const refresh = () => setRequest(agentModels(provider, true));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        {typing ? (
          <input
            className={inputClass}
            value={value ?? ""}
            placeholder={
              fallbackDefault
                ? `Default: ${fallbackDefault.name}`
                : "Model id, or leave empty for the default"
            }
            spellCheck={false}
            onChange={(event) => onChange(event.target.value.trim() || null)}
          />
        ) : (
          <div className="min-w-0 flex-1">
            <Select
              label="Model"
              value={findModel(result.models, value)?.id ?? ""}
              options={[
                { value: "", label: defaultLabel(fallbackDefault) },
                ...choices(result.models).map(modelOption),
                { value: OTHER, label: "Other…", description: "Type a model id" },
              ]}
              onChange={(next) => {
                if (next === OTHER) {
                  setTyping(true);
                  onChange(null);
                } else onChange(next || null);
              }}
            />
          </div>
        )}
        {result.models.length > 0 && typing ? (
          <Button onClick={() => setTyping(false)}>List</Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          aria-label="Ask the agent again"
          title="Ask the agent again"
          onClick={refresh}
        >
          <RotateCw />
        </Button>
      </div>
      {result.error ? <p className="text-caption text-foreground/50">{result.error}</p> : null}
      {!result.error && findModel(result.models, value)?.description ? (
        <p className="text-caption text-foreground/45">
          {findModel(result.models, value)?.description}
        </p>
      ) : null}
    </div>
  );
}

/** The model chip in a thread's header: switch models between turns. */
export function ThreadModelSelect({
  threadId,
  provider,
  model,
  disabled,
}: {
  threadId: string;
  provider: string;
  model: string | null;
  disabled: boolean;
}) {
  return (
    <Suspense fallback={<ModelChip text={model ?? "default"} />}>
      <ThreadModelSelectInner
        threadId={threadId}
        provider={provider}
        model={model}
        disabled={disabled}
      />
    </Suspense>
  );
}

function ModelChip({ text }: { text: string }) {
  return (
    <span className="inline-flex h-5 items-center rounded-xs border bg-card px-1.5 text-mono-xs text-foreground/65">
      {text}
    </span>
  );
}

function ThreadModelSelectInner({
  threadId,
  provider,
  model,
  disabled,
}: {
  threadId: string;
  provider: string;
  model: string | null;
  disabled: boolean;
}) {
  const { models } = use(agentModels(provider));
  const [error, setError] = useState<string | null>(null);
  const current = findModel(models, model);
  if (models.length === 0) return <ModelChip text={model ?? "default"} />;
  const options: DropdownOption[] = [
    ...(!current && model ? [{ value: model, label: model }] : []),
    ...(!model
      ? [{ value: "", label: defaultLabel(models.find((option) => option.isDefault)) }]
      : []),
    ...choices(models).map(modelOption),
  ];
  return (
    <Select
      label="Model"
      title={
        error ??
        (disabled ? "Switch models between turns" : "Switch model (the conversation carries over)")
      }
      disabled={disabled}
      invalid={Boolean(error)}
      value={current?.id ?? model ?? ""}
      options={options}
      onChange={(next) => {
        setError(null);
        void client
          .request("thread.setModel", { threadId, model: next || null })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      }}
      triggerClassName={chipTrigger}
    />
  );
}

/** The agent chip in a thread's header: hand the thread to another agent between turns. */
export function ThreadAgentSelect({
  threadId,
  provider,
  disabled,
}: {
  threadId: string;
  provider: string;
  disabled: boolean;
}) {
  return (
    <Suspense fallback={<ModelChip text={provider} />}>
      <ThreadAgentSelectInner threadId={threadId} provider={provider} disabled={disabled} />
    </Suspense>
  );
}

function ThreadAgentSelectInner({
  threadId,
  provider,
  disabled,
}: {
  threadId: string;
  provider: string;
  disabled: boolean;
}) {
  const statuses = use(agentStatuses());
  const [error, setError] = useState<string | null>(null);
  const available = statuses.filter((status) => status.installed || status.provider === provider);
  const options: DropdownOption[] = available.map((status) => ({
    value: status.provider,
    label: status.label,
    description: status.description,
    hint: status.auth.state === "needs-sign-in" ? "Sign in" : null,
    group: status.group === "featured" ? "Agents" : "ACP registry",
  }));
  return (
    <Select
      label="Agent"
      title={
        error ??
        (disabled
          ? "Switch agents between turns"
          : "Switch agent: the next message brings it up to speed with this thread")
      }
      disabled={disabled}
      invalid={Boolean(error)}
      value={provider}
      options={options}
      onChange={(next) => {
        setError(null);
        void client
          .request("thread.setProvider", { threadId, provider: next, model: null })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      }}
      triggerClassName={cn(chipTrigger, "max-w-44 uppercase tracking-wider")}
    />
  );
}
