import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileChange, FileDiff } from "@agentplane/contracts";

const exec = promisify(execFile);

/** Checkpoint commits are authored by the app, not the user. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "Agentplane",
  GIT_AUTHOR_EMAIL: "checkpoints@agentplane.local",
  GIT_COMMITTER_NAME: "Agentplane",
  GIT_COMMITTER_EMAIL: "checkpoints@agentplane.local",
};

/** A full patch bigger than this is cut off per file (the stats stay exact). */
const MAX_PATCH = 120_000;

/**
 * Past this many untracked files (an unignored node_modules, say) a snapshot
 * would copy all of them into the object store; skip checkpoints instead.
 */
const MAX_UNTRACKED = 20_000;

/** Raised when a turn's changes can't be undone without clobbering later edits. */
export class RevertConflict extends Error {}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return stdout;
}

/** The top of the repository `cwd` is in, or null outside one. Paths below are relative to it. */
async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Record the whole working tree as it is right now (tracked and untracked
 * files, minus what .gitignore excludes) as a commit, without touching the
 * user's index, HEAD or branches: it's built in a throwaway index and kept
 * alive by a ref under refs/agentplane/. Returns null outside a git repo.
 */
export async function snapshot(cwd: string, ref: string): Promise<string | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const index = join(tmpdir(), `agentplane-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index, ...IDENTITY };
  try {
    const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.split("\0").length > MAX_UNTRACKED) return null;
    const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
    if (head) await git(root, ["read-tree", head], env);
    await git(root, ["add", "-A"], env);
    const tree = (await git(root, ["write-tree"], env)).trim();
    const commit = (
      await git(
        root,
        ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "Agentplane checkpoint"],
        env,
      )
    ).trim();
    await git(root, ["update-ref", ref, commit]);
    return commit;
  } catch {
    return null;
  } finally {
    await rm(index, { force: true });
  }
}

const STATUS: Record<string, FileChange["status"]> = {
  A: "added",
  D: "deleted",
  M: "modified",
  T: "modified",
};

/** What changed between two checkpoints, file by file (paths from the repo root). */
export async function changes(cwd: string, before: string, after: string): Promise<FileChange[]> {
  const [names, numbers] = await Promise.all([
    git(cwd, ["diff", "--no-renames", "--name-status", "-z", before, after]),
    git(cwd, ["diff", "--no-renames", "--numstat", "-z", before, after]),
  ]);
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const entry of numbers.split("\0")) {
    const [added, removed, path] = entry.split("\t");
    if (!path) continue;
    counts.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: removed === "-" ? null : Number(removed),
    });
  }
  const parts = names.split("\0").filter(Boolean);
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = STATUS[(parts[i] ?? "M").charAt(0)] ?? "modified";
    const path = parts[i + 1] as string;
    files.push({ path, status, ...(counts.get(path) ?? { additions: null, deletions: null }) });
  }
  return files;
}

/** The unified diff between two checkpoints, split per file. */
export async function diff(cwd: string, before: string, after: string): Promise<FileDiff[]> {
  const files = await changes(cwd, before, after);
  const patch = await git(cwd, ["diff", "--no-renames", "--no-color", before, after]);
  const byPath = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const match = /^diff --git a\/(.+?) b\//.exec(chunk);
    if (match?.[1]) byPath.set(match[1], chunk);
  }
  return files.map((file) => {
    const text = byPath.get(file.path) ?? "";
    // Drop git's header lines; keep hunks.
    const start = text.search(/^@@/m);
    const body = start === -1 ? "" : text.slice(start);
    return {
      ...file,
      patch: body.length > MAX_PATCH ? `${body.slice(0, MAX_PATCH)}\n… (truncated)` : body,
    };
  });
}

/**
 * Undo a turn: apply its changes in reverse to the working tree, so edits made
 * since (by later turns or by hand) survive. If they overlap, nothing changes
 * and RevertConflict is thrown; `overwrite` then puts the turn's files back
 * exactly as they were before it, discarding those later edits to them.
 */
export async function revert(
  cwd: string,
  before: string,
  after: string,
  overwrite = false,
): Promise<string[]> {
  const root = await repoRoot(cwd);
  if (!root) throw new Error("This folder is no longer a git repository.");
  const files = await changes(root, before, after);
  if (files.length === 0) return [];
  if (overwrite) {
    const restore = files.filter((file) => file.status !== "added").map((file) => file.path);
    if (restore.length > 0) {
      await git(root, ["restore", `--source=${before}`, "--worktree", "--", ...restore]);
    }
    for (const file of files.filter((f) => f.status === "added")) {
      await unlink(join(root, file.path)).catch(() => undefined);
    }
    return files.map((file) => file.path);
  }
  const patch = join(tmpdir(), `agentplane-revert-${randomUUID()}.patch`);
  try {
    await writeFile(patch, await git(root, ["diff", "--binary", "--no-renames", after, before]));
    // All or nothing: git apply changes no file unless every hunk applies.
    await git(root, ["apply", "--whitespace=nowarn", patch]);
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim();
    throw new RevertConflict(
      `Files this turn changed were edited again since, so it can't be undone cleanly.${detail ? `\n${detail}` : ""}`,
    );
  } finally {
    await rm(patch, { force: true });
  }
  return files.map((file) => file.path);
}

/** Forget a thread's checkpoints (its refs), e.g. when the thread is deleted. */
export async function dropCheckpoints(cwd: string, threadId: string): Promise<void> {
  try {
    const refs = await git(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/agentplane/${threadId}/`,
    ]);
    for (const ref of refs.split("\n").filter(Boolean)) await git(cwd, ["update-ref", "-d", ref]);
  } catch {
    // Not a repo any more, or already gone.
  }
}
