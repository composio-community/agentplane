import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { AcpLaunch } from "./acp.ts";
import { which } from "./detect.ts";

const exec = promisify(execFile);

/** The official ACP agent registry (https://github.com/agentclientprotocol/registry). */
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

const Env = z.record(z.string(), z.string()).optional();
const PackageDistribution = z.object({
  package: z.string(),
  args: z.array(z.string()).optional(),
  env: Env,
});
const BinaryTarget = z.object({
  archive: z.string().url(),
  // Relative to the unpacked archive; never allowed to climb out of it.
  cmd: z.string().refine((cmd) => !cmd.split(/[\\/]/).includes(".."), "cmd escapes the archive"),
  sha256: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: Env,
});

export const RegistryAgent = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  name: z.string(),
  // Used as a folder name under tools/: a version, never a path.
  version: z.string().regex(/^[\w][\w.+-]*$/),
  description: z.string().optional(),
  website: z.string().optional(),
  distribution: z.object({
    npx: PackageDistribution.optional(),
    uvx: PackageDistribution.optional(),
    binary: z.record(z.string(), BinaryTarget).optional(),
  }),
});
export type RegistryAgent = z.infer<typeof RegistryAgent>;

/** The registry's platform key for this machine. */
export function platformKey(): string {
  const os = platform() === "win32" ? "windows" : platform();
  const cpu = arch() === "arm64" ? "aarch64" : arch() === "x64" ? "x86_64" : arch();
  return `${os}-${cpu}`;
}

/** Parse a registry document, skipping agents we can't understand. */
export function parseRegistry(document: unknown): RegistryAgent[] {
  const agents = (document as { agents?: unknown[] } | null)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((agent) => {
    const parsed = RegistryAgent.safeParse(agent);
    return parsed.success ? [parsed.data] : [];
  });
}

export type LaunchPlan =
  | { kind: "binary"; target: z.infer<typeof BinaryTarget> }
  | { kind: "npx"; dist: z.infer<typeof PackageDistribution> }
  | { kind: "uvx"; dist: z.infer<typeof PackageDistribution> };

/** Prefer a native binary for this platform, then npx, then uvx. */
export function launchPlan(agent: RegistryAgent): LaunchPlan | null {
  const binary = agent.distribution.binary?.[platformKey()];
  if (binary) return { kind: "binary", target: binary };
  if (agent.distribution.npx) return { kind: "npx", dist: agent.distribution.npx };
  if (agent.distribution.uvx) return { kind: "uvx", dist: agent.distribution.uvx };
  return null;
}

/** How a registry agent would run here, or why it can't. */
export async function availability(
  agent: RegistryAgent,
): Promise<{ available: boolean; note: string }> {
  const plan = launchPlan(agent);
  if (!plan) return { available: false, note: `No build for ${platformKey()}` };
  if (plan.kind === "binary") return { available: true, note: "Downloads on first use" };
  const tool = plan.kind;
  return (await which(tool))
    ? { available: true, note: `Runs via ${tool}` }
    : { available: false, note: `Needs ${tool} on your PATH` };
}

export class AgentRegistry {
  private agents: RegistryAgent[] | null = null;
  private loadedAt = 0;
  private loading: Promise<RegistryAgent[]> | null = null;
  private readonly installs = new Map<string, Promise<string>>();

  constructor(private readonly toolsDir: string) {}

  private get cachePath(): string {
    return join(this.toolsDir, "acp-registry.json");
  }

  /** Memory, then a fresh cache file, then the network; a stale cache beats nothing. */
  load(): Promise<RegistryAgent[]> {
    if (this.agents && Date.now() - this.loadedAt < CACHE_TTL_MS)
      return Promise.resolve(this.agents);
    this.loading ??= this.fetchOrCache().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async fetchOrCache(): Promise<RegistryAgent[]> {
    const cached = await this.readCache();
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return this.remember(cached.agents);
    try {
      const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_REGISTRY_BYTES) throw new Error("Registry is unexpectedly large");
      const agents = parseRegistry(JSON.parse(text));
      await mkdir(this.toolsDir, { recursive: true });
      await writeFile(this.cachePath, text, "utf8");
      return this.remember(agents);
    } catch {
      return this.remember(cached?.agents ?? []);
    }
  }

  private async readCache(): Promise<{ at: number; agents: RegistryAgent[] } | null> {
    try {
      const [text, info] = await Promise.all([
        readFile(this.cachePath, "utf8"),
        stat(this.cachePath),
      ]);
      return { at: info.mtimeMs, agents: parseRegistry(JSON.parse(text)) };
    } catch {
      return null;
    }
  }

  private remember(agents: RegistryAgent[]): RegistryAgent[] {
    this.agents = agents;
    this.loadedAt = Date.now();
    return agents;
  }

  async find(id: string): Promise<RegistryAgent | null> {
    return (await this.load()).find((agent) => agent.id === id) ?? null;
  }

  /** Resolve how to start a registry agent, installing its binary on first use. */
  async launch(
    agent: RegistryAgent,
    notify: (text: string) => void,
    options: { allowInstall?: boolean } = {},
  ): Promise<AcpLaunch> {
    const plan = launchPlan(agent);
    if (!plan) throw new Error(`${agent.name} has no build for ${platformKey()}.`);
    if (plan.kind === "binary") {
      if (options.allowInstall === false && !(await this.isInstalled(agent))) {
        throw new Error(
          `${agent.name} downloads on first use; start a thread with it to see its models.`,
        );
      }
      const dir = await this.install(agent, plan.target, notify);
      return {
        command: join(dir, plan.target.cmd),
        args: plan.target.args ?? [],
        ...(plan.target.env ? { env: plan.target.env } : {}),
      };
    }
    const tool = await which(plan.kind);
    if (!tool) throw new Error(`${agent.name} runs via ${plan.kind}, which isn't on your PATH.`);
    return {
      command: tool,
      args:
        plan.kind === "npx"
          ? ["-y", plan.dist.package, ...(plan.dist.args ?? [])]
          : [plan.dist.package, ...(plan.dist.args ?? [])],
      ...(plan.dist.env ? { env: plan.dist.env } : {}),
    };
  }

  private isInstalled(agent: RegistryAgent): Promise<boolean> {
    return stat(join(this.toolsDir, agent.id, agent.version, ".installed")).then(
      () => true,
      () => false,
    );
  }

  private install(
    agent: RegistryAgent,
    target: z.infer<typeof BinaryTarget>,
    notify: (text: string) => void,
  ): Promise<string> {
    const dir = join(this.toolsDir, agent.id, agent.version);
    let pending = this.installs.get(dir);
    if (!pending) {
      pending = this.installBinary(agent, target, dir, notify).finally(() =>
        this.installs.delete(dir),
      );
      this.installs.set(dir, pending);
    }
    return pending;
  }

  private async installBinary(
    agent: RegistryAgent,
    target: z.infer<typeof BinaryTarget>,
    dir: string,
    notify: (text: string) => void,
  ): Promise<string> {
    const marker = join(dir, ".installed");
    if (
      await stat(marker).then(
        () => true,
        () => false,
      )
    )
      return dir;

    const host = new URL(target.archive).host;
    notify(`Downloading ${agent.name} ${agent.version} from ${host}…`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const archiveName = target.archive.split("/").pop() ?? "archive";
    // Next to the install folder (which is wiped first), so a partial
    // download survives a restart and resumes.
    const archivePath = join(dir, "..", `.download-${agent.version}-${archiveName}`);

    const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;
    await download(target.archive, archivePath, (received, total, attempt) =>
      notify(
        `Downloading ${agent.name} ${agent.version} from ${host}… ${
          total
            ? `${Math.floor((received / total) * 100)}% of ${megabytes(total)}`
            : megabytes(received)
        }${attempt > 1 ? ` (reconnected, try ${attempt})` : ""}`,
      ),
    );
    const hash = createHash("sha256");
    await pipeline(createReadStream(archivePath), hash);
    const digest = hash.digest("hex");
    if (target.sha256 && digest.toLowerCase() !== target.sha256.toLowerCase()) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`${agent.name}'s download failed its checksum; refusing to run it.`);
    }

    notify(`Unpacking ${agent.name}…`);
    if (/\.zip$/i.test(archiveName)) {
      await exec("unzip", ["-q", "-o", archivePath, "-d", dir], { maxBuffer: 64 * 1024 * 1024 });
    } else if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(archiveName)) {
      await exec("tar", ["-xf", archivePath, "-C", dir]);
    } else {
      // A bare executable.
      await exec("cp", [archivePath, join(dir, target.cmd)]);
    }
    await rm(archivePath, { force: true });
    await chmod(join(dir, target.cmd), 0o755).catch(() => undefined);
    await writeFile(marker, JSON.stringify({ archive: target.archive, sha256: digest }), "utf8");
    return dir;
  }
}

const DOWNLOAD_ATTEMPTS = 6;
/** Abort a download that hasn't received a byte in this long, and resume it. */
const STALL_MS = 60_000;

/**
 * Download to `path`, resuming with a Range request when the connection drops
 * or stalls (agent builds run to hundreds of MB; flaky lines cut them off).
 */
export async function download(
  url: string,
  path: string,
  progress: (received: number, total: number, attempt: number) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const have = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    const abort = new AbortController();
    let stall = setTimeout(() => abort.abort(new Error("download stalled")), STALL_MS);
    try {
      const response = await fetch(url, {
        headers: have > 0 ? { range: `bytes=${have}-` } : {},
        signal: abort.signal,
      });
      if (response.status === 416) return; // Already complete.
      if (!response.ok || !response.body) {
        const error = new Error(`HTTP ${response.status}`);
        // A client error won't fix itself by retrying.
        if (response.status >= 400 && response.status < 500) Object.assign(error, { final: true });
        throw error;
      }
      const resumed = response.status === 206;
      const length = Number(response.headers.get("content-length")) || 0;
      const total = length ? (resumed ? have : 0) + length : 0;
      let received = resumed ? have : 0;
      let reported = 0;
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            clearTimeout(stall);
            stall = setTimeout(() => abort.abort(new Error("download stalled")), STALL_MS);
            if (Date.now() - reported > 2_000) {
              reported = Date.now();
              progress(received, total, attempt);
            }
            callback(null, chunk);
          },
        }),
        // The server ignored the range (200): start the file over.
        createWriteStream(path, { flags: resumed ? "a" : "w" }),
      );
      if (total && received < total)
        throw new Error(`connection closed at ${received} of ${total}`);
      return;
    } catch (error) {
      if ((error as { final?: boolean }).final || attempt >= DOWNLOAD_ATTEMPTS) {
        throw new Error(
          `Couldn't download ${url}: ${error instanceof Error ? error.message : error}`,
        );
      }
      await sleep(Math.min(10_000, 1_000 * attempt));
    } finally {
      clearTimeout(stall);
    }
  }
}
