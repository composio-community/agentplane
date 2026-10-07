import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Optional per-repo config, committed at the repo root as `agentplane.json`. */
export type ProjectConfig = {
  /** Shell command run in each new worktree, after files are copied (e.g. "pnpm install --offline"). */
  setup?: string;
  /** Extra gitignored paths to copy into worktrees, beyond .env files. */
  copy?: string[];
};

export type SetupReport = {
  copied: string[];
  cloned: string[];
  script: { command: string; ok: boolean; output: string } | null;
  /** A setup command that didn't run because the user hasn't approved it yet. */
  pendingSetup: string | null;
  ms: number;
};

const ENV_FILE = /^\.env(\..+)?$/;
const NOT_SECRETS = /\.(example|sample|template)$/;

async function readProjectConfig(dir: string): Promise<ProjectConfig> {
  try {
    return JSON.parse(await readFile(join(dir, "agentplane.json"), "utf8")) as ProjectConfig;
  } catch {
    return {};
  }
}

/** Gitignored files and folders in the main checkout (folders collapsed). */
async function ignoredEntries(repoPath: string): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["-C", repoPath, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.split("\n").filter(Boolean);
}

/**
 * APFS can clone a whole directory tree in one kernel call (clonefile(2));
 * `cp -c` clones file by file instead, ~14x slower on a big node_modules.
 * Node has no binding for it, but osascript's JavaScript bridge (on every
 * Mac) can call it directly.
 */
async function cloneDirectory(source: string, target: string): Promise<boolean> {
  try {
    const { stdout } = await exec("osascript", [
      "-l",
      "JavaScript",
      "-e",
      'function run(argv) { ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "int"]]); return $.clonefile(argv[0], argv[1], 0); }',
      source,
      target,
    ]);
    return stdout.trim() === "0";
  } catch {
    return false;
  }
}

/**
 * Copy a directory tree as cheaply as the filesystem allows: APFS clones on
 * macOS and reflinks on Linux share blocks until something writes, so a
 * multi-GB node_modules costs almost nothing in time or disk.
 */
async function cloneTree(source: string, target: string): Promise<boolean> {
  await mkdir(dirname(target), { recursive: true });
  if (process.platform === "darwin" && (await cloneDirectory(source, target))) return true;
  const args =
    process.platform === "darwin"
      ? ["-c", "-R", source, target]
      : process.platform === "linux"
        ? ["-R", "--reflink=auto", source, target]
        : null;
  if (!args) return false;
  try {
    await exec("cp", args, { maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Inside `root` (after resolving symlinks), so a repo's config can't reach the rest of the disk. */
async function within(root: string, path: string): Promise<boolean> {
  try {
    const [base, target] = await Promise.all([realpath(root), realpath(path)]);
    return target === base || target.startsWith(`${base}${sep}`);
  } catch {
    return false;
  }
}

export function runSetup(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
  });
}

/**
 * Make a fresh worktree usable right away: bring over the gitignored bits a
 * checkout needs (.env files, installed dependencies) and run the project's
 * setup command, if it has one.
 */
export async function prepareWorktree(options: {
  repoPath: string;
  worktreePath: string;
  env: NodeJS.ProcessEnv;
  /** Whether the user approved this project's setup command (it's the repo's code). */
  trusted: (command: string) => boolean;
}): Promise<SetupReport> {
  const started = Date.now();
  const config = await readProjectConfig(options.worktreePath);
  const entries = await ignoredEntries(options.repoPath).catch(() => [] as string[]);
  const copied: string[] = [];
  const cloned: string[] = [];

  const files = entries.filter((entry) => {
    const name = basename(entry);
    return !entry.endsWith("/") && ENV_FILE.test(name) && !NOT_SECRETS.test(name);
  });
  for (const extra of config.copy ?? []) {
    if (typeof extra === "string" && !files.includes(extra)) files.push(extra);
  }
  for (const file of files) {
    try {
      // Listed files come from the repo's own config: never outside the repo.
      if (isAbsolute(file) || !(await within(options.repoPath, join(options.repoPath, file)))) {
        continue;
      }
      const target = join(options.worktreePath, file);
      if (!resolve(target).startsWith(`${resolve(options.worktreePath)}${sep}`)) continue;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(options.repoPath, file), target);
      copied.push(file);
    } catch {
      // Listed but unreadable, or gone: skip it.
    }
  }

  // Dependencies: every node_modules folder, cloned in parallel.
  const modules = entries.filter((entry) => /(^|\/)node_modules\/$/.test(entry));
  await Promise.all(
    modules.map(async (entry) => {
      const source = join(options.repoPath, entry);
      const target = join(options.worktreePath, entry);
      const exists = await stat(target).then(
        () => true,
        () => false,
      );
      if (!exists && (await cloneTree(source.replace(/\/$/, ""), target.replace(/\/$/, "")))) {
        cloned.push(entry.replace(/\/$/, ""));
      }
    }),
  );

  const setup = typeof config.setup === "string" && config.setup.trim() ? config.setup : null;
  const approved = setup !== null && options.trusted(setup);
  const script =
    setup && approved
      ? { command: setup, ...(await runSetup(setup, options.worktreePath, options.env)) }
      : null;
  return {
    copied,
    cloned,
    script,
    pendingSetup: setup && !approved ? setup : null,
    ms: Date.now() - started,
  };
}

export function describeSetup(report: SetupReport, portBase: number | null): string {
  const parts: string[] = [];
  if (report.copied.length > 0) parts.push(`copied ${report.copied.join(", ")}`);
  if (report.cloned.length > 0) {
    parts.push(
      `cloned ${report.cloned.length === 1 ? report.cloned[0] : `${report.cloned.length} node_modules folders`}`,
    );
  }
  if (report.script) {
    parts.push(
      report.script.ok ? `ran \`${report.script.command}\`` : `\`${report.script.command}\` failed`,
    );
  }
  if (portBase !== null) parts.push(`PORT=${portBase}`);
  const summary = parts.length > 0 ? parts.join(" · ") : "nothing to copy";
  const head = `Worktree ready in ${(report.ms / 1000).toFixed(1)}s: ${summary}.`;
  return report.script && !report.script.ok
    ? `${head}\n\n\`\`\`\n${report.script.output.slice(-1_500)}\n\`\`\``
    : head;
}
