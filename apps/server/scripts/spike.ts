/**
 * Drive a provider adapter directly and print its normalized events.
 *
 *   pnpm spike <agent> "<prompt>" [--mode supervised|auto-edit|full-access] [--cwd <dir>]
 *   pnpm spike custom "<prompt>" --acp "<acp agent command>"
 *
 * Approvals are auto-approved and questions get their first option, so a
 * supervised run exercises the full request/response loop.
 */
import { parseArgs } from "node:util";
import { Provider, RuntimeMode } from "@agentplane/contracts";
import { resolveConfig } from "../src/config.ts";
import { acpAdapter } from "../src/providers/acp.ts";
import { AgentCatalog } from "../src/providers/index.ts";
import type { AdapterEvent, ProviderSession } from "../src/providers/types.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "supervised" },
    cwd: { type: "string", default: process.cwd() },
    resume: { type: "string" },
    acp: { type: "string" },
  },
});

const catalog = new AgentCatalog(resolveConfig({ dev: true, webDistDir: null }));
await catalog.loadRegistry();
const adapters = catalog.adapters;
const provider = Provider.parse(positionals[0]);
// `custom` runs any ACP command: pnpm spike custom "<prompt>" --acp "npx -y some-acp-agent"
const custom = values.acp?.split(" ").filter(Boolean);
const adapter =
  provider === "custom" && custom?.[0]
    ? acpAdapter({
        id: "custom",
        label: "Custom ACP agent",
        signInHint: "Sign in with the agent's own CLI.",
        launch: async () => ({ command: custom[0] as string, args: custom.slice(1) }),
      })
    : adapters[provider];
if (!adapter)
  throw new Error(`Unknown agent: ${provider}. Known: ${Object.keys(adapters).join(", ")}`);
const prompt = positionals[1] ?? "Say hello in five words.";
const runtimeMode = RuntimeMode.parse(values.mode);

let session: ProviderSession | null = null;
let finish: () => void = () => {};
const done = new Promise<void>((resolve) => {
  finish = resolve;
});

let turnStartedAt = 0;
let firstOutputAt = 0;
const since = (at: number) => `${((Date.now() - at) / 1000).toFixed(2)}s`;

function log(event: AdapterEvent): void {
  if (
    turnStartedAt &&
    !firstOutputAt &&
    event.type === "item" &&
    (event.body.kind === "assistant_message" ||
      event.body.kind === "reasoning" ||
      event.body.kind === "tool_call")
  ) {
    firstOutputAt = Date.now();
    console.log(`⏱ first output ${since(turnStartedAt)} after send`);
  }
  if (event.type === "item") {
    const { body } = event;
    const summary =
      body.kind === "assistant_message" || body.kind === "reasoning"
        ? JSON.stringify(body.text.slice(-80))
        : body.kind === "tool_call"
          ? `${body.title} ${body.detail ?? ""} [${body.status}]${body.output ? ` → ${JSON.stringify(body.output.slice(0, 80))}` : ""}`
          : body.kind === "approval"
            ? `${body.title} ${body.detail ?? ""} [${body.status}]`
            : body.kind === "question"
              ? `${body.questions.map((q) => q.question).join(" / ")} [${body.status}]`
              : body.kind === "plan"
                ? body.steps.map((s) => `${s.status}:${s.text}`).join(", ")
                : body.kind === "error"
                  ? body.message
                  : body.kind === "handoff"
                    ? `${body.mode} handoff to ${body.to}: ${body.included} entries`
                    : body.kind === "setup_request"
                      ? `${body.status}: ${body.command}`
                      : body.text;
    if (event.final || body.kind === "tool_call") {
      console.log(`item ${body.kind}${event.final ? "" : " (streaming)"} ${event.id}: ${summary}`);
    }
    if (body.kind === "approval" && body.status === "pending") {
      setTimeout(() => {
        console.log(`  → approving ${event.id}`);
        session?.respondToRequest(event.id, { kind: "approval", decision: "approve" });
      }, 0);
    }
    if (body.kind === "question" && body.status === "pending") {
      const answers = Object.fromEntries(
        body.questions.map((q) => [q.question, q.options[0]?.label ?? ""]),
      );
      setTimeout(() => {
        console.log(`  → answering ${event.id}`, answers);
        session?.respondToRequest(event.id, { kind: "question", answers });
      }, 0);
    }
    return;
  }
  console.log(event.type, JSON.stringify({ ...event, type: undefined }));
  if (event.type === "turn.completed" || event.type === "session.exited") finish();
}

const started = Date.now();
session = await adapter.openSession({
  cwd: values.cwd,
  runtimeMode,
  model: null,
  resumeId: values.resume ?? null,
  emit: log,
});
console.log(`⏱ session ready ${since(started)}`);
turnStartedAt = Date.now();
await session.startTurn(prompt);
await done;
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await session.close();
process.exit(0);
