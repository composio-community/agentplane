import { execFile, spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { EditorOption } from "@agentplane/contracts";
import { agentEnvironment, which } from "./providers/detect.ts";

const exec = promisify(execFile);

type EditorDef = {
  id: string;
  label: string;
  /** Its command-line launcher, if it has one. */
  cli: string | null;
  /** Its macOS app bundle name, for `open -a` when the CLI isn't installed. */
  macApp: string | null;
  /** CLI args that open a file at a line. */
  gotoArgs?: (file: string, line: number) => string[];
};

const vscodeLike = (file: string, line: number) => ["-g", `${file}:${line}`];
const colonLine = (file: string, line: number) => [`${file}:${line}`];
const jetbrains = (file: string, line: number) => ["--line", String(line), file];

/** In order of preference when the user hasn't picked one. */
const EDITORS: EditorDef[] = [
  {
    id: "vscode",
    label: "VS Code",
    cli: "code",
    macApp: "Visual Studio Code",
    gotoArgs: vscodeLike,
  },
  { id: "cursor", label: "Cursor", cli: "cursor", macApp: "Cursor", gotoArgs: vscodeLike },
  { id: "windsurf", label: "Windsurf", cli: "windsurf", macApp: "Windsurf", gotoArgs: vscodeLike },
  { id: "zed", label: "Zed", cli: "zed", macApp: "Zed", gotoArgs: colonLine },
  {
    id: "sublime",
    label: "Sublime Text",
    cli: "subl",
    macApp: "Sublime Text",
    gotoArgs: colonLine,
  },
  {
    id: "intellij",
    label: "IntelliJ IDEA",
    cli: "idea",
    macApp: "IntelliJ IDEA",
    gotoArgs: jetbrains,
  },
  { id: "webstorm", label: "WebStorm", cli: "webstorm", macApp: "WebStorm", gotoArgs: jetbrains },
  { id: "pycharm", label: "PyCharm", cli: "pycharm", macApp: "PyCharm", gotoArgs: jetbrains },
  {
    id: "xcode",
    label: "Xcode",
    cli: process.platform === "darwin" ? "xed" : null,
    macApp: "Xcode",
    gotoArgs: (file, line) => ["-l", String(line), file],
  },
];

const FILES: EditorOption = {
  id: "files",
  label: process.platform === "darwin" ? "Finder" : "File manager",
};

type Found = { def: EditorDef; cli: string | null };

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function macAppPath(name: string): Promise<string | null> {
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    const path = join(dir, `${name}.app`);
    if (await exists(path)) return path;
  }
  return null;
}

async function detect(def: EditorDef): Promise<Found | null> {
  const cli = def.cli ? await which(def.cli) : null;
  if (cli && process.platform === "darwin") {
    // `code` is often another editor's launcher (Cursor installs one): only
    // count a CLI that lives in this editor's own app bundle, or outside any.
    const real = await realpath(cli).catch(() => cli);
    const bundle = /\/([^/]+)\.app\//.exec(real)?.[1];
    if (!bundle || bundle === def.macApp) return { def, cli };
  } else if (cli) {
    return { def, cli };
  }
  if (process.platform === "darwin" && def.macApp && (await macAppPath(def.macApp))) {
    return { def, cli: null };
  }
  return null;
}

let found: { at: number; editors: Promise<Found[]> } | null = null;

/** Installed editors, rechecked at most every minute. */
function installed(): Promise<Found[]> {
  if (!found || Date.now() - found.at > 60_000) {
    found = {
      at: Date.now(),
      editors: Promise.all(EDITORS.map(detect)).then((all) =>
        all.filter((editor): editor is Found => editor !== null),
      ),
    };
  }
  return found.editors;
}

export async function listEditors(): Promise<EditorOption[]> {
  const editors = await installed();
  return [...editors.map(({ def }) => ({ id: def.id, label: def.label })), FILES];
}

/**
 * Open a folder, or a file (at a line when the editor can), in an editor on
 * this computer. `id` "files" shows it in Finder / the file manager instead.
 */
export async function openInEditor(id: string, target: EditorTarget): Promise<void> {
  if (id === FILES.id) {
    const mac = process.platform === "darwin";
    const args = mac && target.isFile ? ["-R", target.path] : [target.path];
    return launch(mac ? "open" : "xdg-open", args);
  }
  const editor = (await installed()).find(({ def }) => def.id === id);
  if (!editor) throw new OpenError("That editor isn't installed any more.");
  const { def, cli } = editor;
  if (cli) {
    const args =
      target.isFile && target.line && def.gotoArgs
        ? def.gotoArgs(target.path, target.line)
        : [target.path];
    return launch(cli, args);
  }
  // No CLI: macOS can still hand the path to the app (without a line).
  return launch("open", ["-a", def.macApp as string, target.path]);
}

async function launch(command: string, args: string[]): Promise<void> {
  const env = await agentEnvironment();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export type EditorTarget = { path: string; isFile: boolean; line?: number };

/**
 * What to open for a thread: its folder, or a path in it. Relative paths are
 * from the repo root (how turn changes list them). Nothing outside the repo or
 * the thread's folder.
 */
export async function editorTarget(
  cwd: string,
  path?: string,
  line?: number,
): Promise<EditorTarget> {
  if (!path) return { path: cwd, isFile: false };
  const root = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).then(
    ({ stdout }) => stdout.trim() || cwd,
    () => cwd,
  );
  const candidate = isAbsolute(path) ? path : resolve(root, path);
  const real = await realpath(candidate).catch(() => null);
  if (!real) throw new OpenError("That file isn't there any more.");
  const bases = await Promise.all([root, cwd].map((base) => realpath(base).catch(() => base)));
  if (!bases.some((base) => real === base || real.startsWith(`${base}${sep}`))) {
    throw new OpenError("Only files in this thread's repository can be opened.");
  }
  const isFile = (await stat(real)).isFile();
  return { path: real, isFile, ...(isFile && line ? { line } : {}) };
}

/** A problem worth showing the user as is. */
export class OpenError extends Error {}
