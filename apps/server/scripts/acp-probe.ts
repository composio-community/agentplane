/**
 * Talk raw ACP to an agent and print everything it says. For debugging a new
 * or misbehaving ACP agent before (or instead of) going through the adapter.
 *
 *   pnpm --filter @agentplane/server exec tsx scripts/acp-probe.ts --cwd <dir> "<prompt>" -- <binary> [args...]
 *
 * Permission requests are answered with the first "allow" option.
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const separator = process.argv.indexOf("--");
if (separator < 0) throw new Error("Usage: acp-probe [--cwd dir] <prompt> -- <binary> [args...]");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2, separator),
  allowPositionals: true,
  options: { cwd: { type: "string", default: process.cwd() } },
});
const [binary, ...args] = process.argv.slice(separator + 1);
if (!binary) throw new Error("Missing agent command after --");
const prompt = positionals[0] ?? "Say hello in five words.";

const child = spawn(binary, args, { cwd: values.cwd, stdio: ["pipe", "pipe", "inherit"] });
child.on("exit", (code) => console.log(`[exit ${code}]`));
const print = (label: string, value: unknown) =>
  console.log(`${label} ${JSON.stringify(value, null, 2).slice(0, 2_000)}`);

const connection = new ClientSideConnection(
  () => ({
    async requestPermission(params) {
      print("← request_permission", params);
      const allow = params.options.find((option) => option.kind.startsWith("allow"));
      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      const { sessionUpdate, ...rest } = params.update;
      console.log(`← ${sessionUpdate} ${JSON.stringify(rest).slice(0, 400)}`);
    },
  }),
  ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ),
);

const init = await connection.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "agentplane-probe", version: "0.0.0" },
});
print("initialize →", init);
const session = await connection.newSession({ cwd: values.cwd, mcpServers: [] });
print("session/new →", session);
const result = await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: prompt }],
});
print("prompt →", result);
child.kill("SIGTERM");
process.exit(0);
