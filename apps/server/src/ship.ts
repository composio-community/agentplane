import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatus } from "@agentplane/contracts";
import { agentEnvironment, which } from "./providers/detect.ts";

const exec = promisify(execFile);

/** A step failed in a way worth showing the user as is (a hook, a rejected push). */
export class ShipError extends Error {}

/**
 * Run the user's own git / gh, with their PATH (credential helpers, signing
 * tools) and never a terminal prompt, which would hang with nobody to answer.
 */
async function run(command: string, cwd: string, args: string[], timeout = 120_000) {
  const env = { ...(await agentEnvironment()), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  try {
    const { stdout } = await exec(command, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const { stderr, stdout, killed } = error as {
      stderr?: string;
      stdout?: string;
      killed?: boolean;
    };
    if (killed) throw new ShipError(`\`${command} ${args[0]}\` took too long and was stopped.`);
    const detail = (stderr || stdout || "").trim().split("\n").slice(-12).join("\n");
    throw new ShipError(detail || `\`${command} ${args[0]}\` failed.`);
  }
}

const git = (cwd: string, ...args: string[]) => run("git", cwd, args);

const ghStates = new Map<string, { at: number; state: Promise<GitStatus["gh"]> }>();

/**
 * Whether the GitHub CLI is installed and signed in to the remote's host
 * (checked every few minutes). Remotes off GitHub are "unsupported".
 */
function ghReady(host: string | null): Promise<GitStatus["gh"]> {
  if (!host?.includes("github")) return Promise.resolve("unsupported");
  let known = ghStates.get(host);
  if (!known || Date.now() - known.at > 5 * 60_000) {
    known = {
      at: Date.now(),
      state: (async () => {
        const gh = await which("gh");
        if (!gh) return "missing";
        return run(gh, process.cwd(), ["auth", "status", "--hostname", host], 15_000).then(
          () => "ready" as const,
          () => "signed-out" as const,
        );
      })(),
    };
    ghStates.set(host, known);
  }
  return known.state;
}

/** The host of a network remote ("github.com"), or null for a local path. */
function remoteHost(url: string): string | null {
  return (
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1] ?? /^[^@/]+@([^:]+):/.exec(url)?.[1] ?? null
  );
}

const PORCELAIN: Record<string, GitStatus["changes"][number]["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
  U: "conflicted",
};

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => null);
  const empty: GitStatus = {
    repo: false,
    branch: null,
    defaultBranch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    remote: null,
    gh: "unsupported",
    pr: null,
  };
  if (!root) return empty;

  const [branch, upstream, porcelain, remote, originHead] = await Promise.all([
    git(root, "symbolic-ref", "--short", "-q", "HEAD").catch(() => null),
    git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").catch(() => null),
    git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    git(root, "remote", "get-url", "origin").catch(() => null),
    git(root, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD").catch(() => null),
  ]);
  const gh = await ghReady(remote ? remoteHost(remote) : null);

  const changes: GitStatus["changes"] = [];
  const entries = porcelain.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // Renames carry the old path in the next entry.
    if (code.includes("R") || code.includes("C")) i++;
    const letter = code === "??" ? "?" : (code.trim()[0] ?? "M");
    changes.push({
      path,
      status: letter === "?" ? "untracked" : (PORCELAIN[letter] ?? "modified"),
    });
  }

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await git(
      root,
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${upstream}`,
    ).catch(() => "0\t0");
    const [left, right] = counts.split(/\s+/).map(Number);
    ahead = left ?? 0;
    behind = right ?? 0;
  }

  let defaultBranch = originHead ? originHead.replace(/^origin\//, "") : null;
  if (!defaultBranch) {
    for (const candidate of ["main", "master"]) {
      if (
        await git(root, "rev-parse", "--verify", "-q", candidate).then(
          () => true,
          () => false,
        )
      ) {
        defaultBranch = candidate;
        break;
      }
    }
  }

  let pr: GitStatus["pr"] = null;
  if (gh === "ready" && remote && branch && branch !== defaultBranch) {
    pr = await run("gh", root, ["pr", "view", "--json", "number,url,state,title"], 20_000)
      .then((json) => JSON.parse(json) as NonNullable<GitStatus["pr"]>)
      .catch(() => null);
  }

  return {
    repo: true,
    branch,
    defaultBranch,
    upstream,
    ahead,
    behind,
    changes,
    remote: remote ? displayRemote(remote) : null,
    gh,
    pr,
  };
}

/** "git@github.com:acme/api.git" → "github.com/acme/api". */
function displayRemote(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, "")
    .replace(/^[^@/]+@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
}

export type ShipRequest = {
  /** Switch to a new branch (from the current HEAD) first. */
  branch?: string;
  /** Commit everything that changed, with this message. */
  message?: string;
  push: boolean;
  pr?: { title: string; body: string; draft: boolean };
};

export type ShipResult = {
  branch: string | null;
  sha: string | null;
  pushed: boolean;
  prUrl: string | null;
};

/**
 * Commit, push and open a pull request, in that order, stopping at the first
 * step that fails. Hooks run as they would for the user; nothing is skipped.
 */
export async function ship(cwd: string, request: ShipRequest): Promise<ShipResult> {
  const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => {
    throw new ShipError("This thread's folder isn't a git repository.");
  });
  const result: ShipResult = { branch: null, sha: null, pushed: false, prUrl: null };
  const done = () => {
    const parts = [
      result.branch ? `switched to ${result.branch}` : null,
      result.sha ? `committed ${result.sha}` : null,
      result.pushed ? "pushed" : null,
    ].filter(Boolean);
    return parts.length > 0 ? `Done so far: ${parts.join(", ")}. ` : "";
  };
  const step = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ShipError(`${done()}${label} failed:\n${message}`);
    }
  };

  if (request.branch) {
    const name = request.branch.trim();
    await step("Creating the branch", async () => {
      await git(root, "check-ref-format", "--branch", name);
      await git(root, "switch", "-c", name);
    });
    result.branch = name;
  }
  if (request.message?.trim()) {
    const message = request.message.trim();
    await step("Committing", async () => {
      await git(root, "add", "-A");
      await git(root, "commit", "-m", message);
    });
    result.sha = await git(root, "rev-parse", "--short", "HEAD");
  }
  if (request.push || request.pr) {
    await step("Pushing", async () => {
      const upstream = await git(root, "rev-parse", "--abbrev-ref", "@{upstream}").catch(
        () => null,
      );
      if (upstream) await git(root, "push");
      else await git(root, "push", "-u", "origin", "HEAD");
    });
    result.pushed = true;
  }
  if (request.pr) {
    const { title, body, draft } = request.pr;
    const output = await step("Opening the pull request", () =>
      run("gh", root, [
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        ...(draft ? ["--draft"] : []),
      ]),
    );
    result.prUrl = output.split("\n").findLast((line) => /^https?:\/\//.test(line)) ?? null;
  }
  return result;
}
