import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentEnvironment } from "./detect.ts";

const exec = promisify(execFile);

export type AuthState = { state: "ready" | "needs-sign-in" | "unknown"; detail: string | null };

/** Errors that mean "fix the agent's setup", not "something went wrong in the task". */
export function classifySetup(error: string): "sign-in" | "update" | null {
  if (
    /cursor-agent update|lack ACP|unknown command|closed the connection without answering/i.test(
      error,
    )
  ) {
    return "update";
  }
  if (
    /(isn't|not) signed in|sign in to|not logged in|not authenticated|log ?in (first|required)|authenticat(e|ion) (first|required)|unauthori[sz]ed|\b401\b|invalid api key|api key (is )?(missing|invalid|not set)|no credentials|free tier can only be used|no longer supported for gemini code assist|ineligibletier|\/login/i.test(
      error,
    )
  ) {
    return "sign-in";
  }
  return null;
}

/**
 * The most recent error an agent logged on stderr. Agents like OpenCode end a
 * failed turn quietly over the protocol but log why; this digs that out.
 */
export function lastLoggedError(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] as string;
    const field = /\berror=(.+?)(?:\s+stack=|$)/.exec(line);
    if (field?.[1] && !field[1].startsWith("{")) return clean(field[1]);
    if (/^(error|fatal)\b[:\s]/i.test(line) && !line.includes('{"error"'))
      return clean(line.replace(/^(error|fatal)\b[:\s]*/i, ""));
  }
  return null;
}

function clean(text: string): string {
  const unquoted = text.replace(/^"(.*)"$/, "$1").trim();
  return unquoted.length > 300 ? `${unquoted.slice(0, 297)}…` : unquoted;
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Open the user's Terminal running a sign-in command. The command comes from
 * our own agent catalog (a resolved binary plus fixed args), never from input.
 */
export async function openTerminal(
  command: string[],
): Promise<{ opened: boolean; command: string }> {
  const line = command.map(shellQuote).join(" ");
  if (process.platform !== "darwin") return { opened: false, command: line };
  const script = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    await exec("osascript", [
      "-e",
      'tell application "Terminal"',
      "-e",
      "activate",
      "-e",
      `do script "${script}"`,
      "-e",
      "end tell",
    ]);
    return { opened: true, command: line };
  } catch {
    return { opened: false, command: line };
  }
}

async function run(binary: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await exec(binary, args, {
      timeout: 8_000,
      env: await agentEnvironment(),
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}` };
  }
}

// Strip terminal colors and cursor codes before reading CLI output.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences.
const strip = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/** Cheap "is it signed in?" checks using each CLI's own status command; no tokens spent. */
export const AUTH_CHECKS: Record<string, (binary: string) => Promise<AuthState>> = {
  async claude(binary) {
    const { output } = await run(binary, ["auth", "status"]);
    const loggedIn = /"loggedIn"\s*:\s*true/.test(output) || Boolean(process.env.ANTHROPIC_API_KEY);
    return loggedIn
      ? { state: "ready", detail: null }
      : { state: "needs-sign-in", detail: "Claude Code isn't signed in." };
  },
  async codex(binary) {
    const { ok, output } = await run(binary, ["login", "status"]);
    return ok && /logged in/i.test(output)
      ? { state: "ready", detail: null }
      : { state: "needs-sign-in", detail: "Codex isn't signed in." };
  },
  async opencode(binary) {
    const { output } = await run(binary, ["auth", "list"]);
    const count = Number(/(\d+)\s+credentials?/i.exec(strip(output))?.[1] ?? "0");
    return count > 0
      ? { state: "ready", detail: null }
      : {
          state: "needs-sign-in",
          detail:
            "No model provider is signed in (OpenCode's free tier only works inside OpenCode).",
        };
  },
  async cursor(binary) {
    const { output } = await run(binary, ["status"]);
    const text = strip(output);
    if (/not logged in/i.test(text))
      return { state: "needs-sign-in", detail: "Cursor isn't signed in." };
    return /logged in/i.test(text)
      ? { state: "ready", detail: null }
      : { state: "unknown", detail: null };
  },
};
