#!/usr/bin/env -S npx tsx
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { resolveConfig } from "./config.ts";
import { startServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    home: { type: "string" },
    dev: { type: "boolean", default: false },
    /** Don't open the browser (it opens the signed-in launch link by default). */
    "no-open": { type: "boolean", default: false },
  },
});

// One bad request or a stray promise in an adapter must not take down every
// running agent with it: log and keep serving.
process.on("unhandledRejection", (error) => console.error("[unhandled]", error));
process.on("uncaughtException", (error) => console.error("[uncaught]", error));

const here = dirname(fileURLToPath(import.meta.url));

// The app used to be called Orchestration and kept its state in
// ~/.orchestration. Move it to ~/.agentplane once, leaving a link behind so
// absolute paths saved in threads (worktrees, git's worktree records) still work.
if (!values.home && !process.env.AGENTPLANE_HOME) {
  const legacy = join(homedir(), ".orchestration");
  const current = join(homedir(), ".agentplane");
  try {
    if (!existsSync(current) && existsSync(legacy) && !lstatSync(legacy).isSymbolicLink()) {
      renameSync(legacy, current);
      symlinkSync(current, legacy);
      console.log(`Moved ${legacy} to ${current}`);
    }
  } catch (error) {
    console.error("[migrate] couldn't move the old state folder:", error);
  }
}

// The app's own keys may sit in a .env at the repo root (gitignored). Only
// these are read: the rest of that file is the user's business, and agents
// shouldn't inherit it.
try {
  const saved = parseEnv(readFileSync(join(here, "../../../.env"), "utf8"));
  for (const name of ["COMPOSIO_API_KEY", "OPENROUTER_API_KEY"]) {
    if (saved[name] && !process.env[name]) process.env[name] = saved[name];
  }
} catch {
  // No .env: fine.
}
const config = resolveConfig({
  ...(values.port ? { port: Number(values.port) } : {}),
  ...(values.home ? { homeDir: values.home } : {}),
  dev: values.dev,
  webDistDir: join(here, "../../web/dist"),
});

const server = await startServer(config);
console.log(`Agentplane server listening on ${server.url}`);
console.log(`State: ${config.dbPath}`);
console.log(
  `\nOpen Agentplane (this link signs the browser in; it changes every start):\n  ${server.launchUrl}\n`,
);
if (!values["no-open"] && !process.env.CI) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? null : "xdg-open";
  // Dev waits for Vite to come up before opening.
  if (opener)
    setTimeout(() => execFile(opener, [server.launchUrl], () => undefined), values.dev ? 2_000 : 0);
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
