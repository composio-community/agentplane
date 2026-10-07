import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

/**
 * Create a worktree on a new branch from the repo's current HEAD, so the agent
 * works in isolation and the user's checkout is never touched.
 */
export async function createWorktree(options: {
  repoPath: string;
  worktreesDir: string;
  shortId: string;
}): Promise<{ path: string; branch: string }> {
  const project = slug(basename(options.repoPath));
  const branch = `agentplane/${options.shortId}`;
  const parent = join(options.worktreesDir, project);
  const path = join(parent, options.shortId);
  mkdirSync(parent, { recursive: true });
  await git(options.repoPath, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { path, branch };
}
