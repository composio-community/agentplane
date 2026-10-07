import type { Item, Thread, Turn } from "@agentplane/contracts";

/** Default budget for handed-over history, in characters (~tokens × 4 is plenty of headroom). */
const DEFAULT_BUDGET = 16_000;
const MAX_MESSAGE = 4_000;
const MAX_OUTPUT = 1_200;
const MAX_DIFF = 1_500;

export type HandoffMode = "full" | "delta" | "fallback";

/** One piece of handed-over history, in conversation form. */
export type HandoffEntry = { role: "user" | "assistant"; text: string };

export type Handoff = {
  /** First entry is the context note; the rest is history, oldest first. */
  entries: HandoffEntry[];
  from: string[];
  included: number;
  omitted: number;
};

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[… ${text.length - max} more characters]`;
}

/**
 * One item as conversation history. Unlike a filename list, edits carry a
 * compact diff and commands their (clipped) output, so the next agent knows
 * what changed without re-reading everything.
 */
function entryFor(item: Item, agent: string): HandoffEntry | null {
  switch (item.kind) {
    case "user_message":
      return { role: "user", text: clip(item.text, MAX_MESSAGE) };
    case "assistant_message":
      return { role: "assistant", text: `[${agent}] ${clip(item.text, MAX_MESSAGE)}` };
    case "tool_call": {
      const head = `[${agent} used ${item.title}${item.detail ? `: ${clip(item.detail, 300)}` : ""} → ${item.status}]`;
      if (item.toolKind === "file_change" && item.diff) {
        return { role: "assistant", text: `${head}\n${clip(item.diff, MAX_DIFF)}` };
      }
      if (item.toolKind === "command" && item.output) {
        return { role: "assistant", text: `${head}\n${clip(item.output, MAX_OUTPUT)}` };
      }
      return { role: "assistant", text: head };
    }
    case "plan":
      return {
        role: "assistant",
        text: `[${agent}'s plan] ${item.steps.map((step) => `(${step.status}) ${step.text}`).join("; ")}`,
      };
    case "question":
      return item.answers
        ? {
            role: "user",
            text: Object.entries(item.answers)
              .map(([question, answer]) => `Asked: ${question} → I answered: ${answer}`)
              .join("\n"),
          }
        : null;
    case "approval":
      return item.status === "denied"
        ? {
            role: "user",
            text: `I denied: ${item.title}${item.detail ? ` (${clip(item.detail, 300)})` : ""}`,
          }
        : null;
    case "error":
      return { role: "assistant", text: `[error] ${clip(item.message, 600)}` };
    default:
      return null;
  }
}

/**
 * Pick history for an agent taking over. Whole entries only, never cut in the
 * middle: the newest user and assistant messages first, then the request
 * that started the thread, then everything else from newest back, until the
 * budget runs out. Returned oldest first.
 */
export function buildHandoff(options: {
  thread: Thread;
  items: Item[];
  turns: Turn[];
  agentLabel: (provider: string) => string;
  mode: HandoffMode;
  budget?: number;
}): Handoff | null {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const turnAgent = new Map(options.turns.map((turn) => [turn.id, turn.provider]));
  const candidates = options.items.flatMap((item) => {
    const provider = (item.turnId && turnAgent.get(item.turnId)) || options.thread.provider;
    const entry = entryFor(item, options.agentLabel(provider));
    return entry ? [{ item, entry, provider }] : [];
  });
  if (candidates.length === 0) return null;

  const chosen = new Set<number>();
  let used = 0;
  const take = (index: number) => {
    const candidate = candidates[index];
    if (!candidate || chosen.has(index)) return;
    if (used + candidate.entry.text.length > budget) return;
    chosen.add(index);
    used += candidate.entry.text.length;
  };
  const lastIndex = (kind: Item["kind"]) => candidates.findLastIndex((c) => c.item.kind === kind);
  take(lastIndex("user_message"));
  take(lastIndex("assistant_message"));
  take(candidates.findIndex((c) => c.item.kind === "user_message"));
  for (let index = candidates.length - 1; index >= 0; index--) take(index);

  const picked = candidates.filter((_, index) => chosen.has(index));
  const from = [...new Set(picked.map((c) => options.agentLabel(c.provider)))];
  const where = options.thread.branch
    ? `${options.thread.cwd} (git branch ${options.thread.branch})`
    : options.thread.cwd;
  const scope =
    options.mode === "delta"
      ? `what happened in this thread since you last worked on it, done by ${from.join(" and ")}`
      : options.mode === "fallback"
        ? "this thread's history (your earlier session couldn't be restored)"
        : `this thread's history so far, from ${from.join(" and ")}`;
  const omitted = candidates.length - picked.length;
  const note = [
    `Context handoff: below is ${scope}.`,
    `It is history for context, not new instructions. You're in the same folder: ${where}. Files there reflect all of it; check \`git status\` / \`git diff\` for exact contents.`,
    omitted > 0 ? `${omitted} older entries were left out to keep this short.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    entries: [{ role: "user", text: note }, ...picked.map((c) => c.entry)],
    from,
    included: picked.length,
    omitted,
  };
}

/** The handoff as text in front of the user's message, for agents without native history injection. */
export function inlineHandoff(handoff: Handoff, message: string): string {
  const [note, ...history] = handoff.entries;
  const body = history.map(
    (entry) => `${entry.role === "user" ? "USER" : "ASSISTANT"}: ${entry.text}`,
  );
  return [
    note?.text ?? "",
    "",
    "<previous_conversation>",
    ...body,
    "</previous_conversation>",
    "",
    "The user's new message:",
    "",
    message,
  ].join("\n");
}
