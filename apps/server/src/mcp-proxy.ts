import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

type Upstream = { url: string; headers: Record<string, string> };

/** What an MCP client sends that the upstream needs (Streamable HTTP transport). */
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

/**
 * Agents reach hosted MCP servers (Composio) through this server instead of
 * directly, so their real URL and API key never appear on an agent's command
 * line (readable by every account via `ps`) or in a third-party agent's hands.
 * Agents get a loopback URL with a per-run token; the key is added here.
 */
export class McpProxy {
  private readonly token = randomBytes(24).toString("base64url");
  private readonly upstreams = new Map<string, () => Promise<Upstream | null>>();

  constructor(private readonly port: number) {}

  /** The local URL agents use for `name`; `resolve` gives the real endpoint per request. */
  register(name: string, resolve: () => Promise<Upstream | null>): string {
    this.upstreams.set(name, resolve);
    return `http://127.0.0.1:${this.port}/mcp/${this.token}/${name}`;
  }

  /** Serves `/mcp/<token>/<name>`; returns false for any other path. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const match = /^\/mcp\/([^/]+)\/([\w-]+)$/.exec((req.url ?? "/").split("?")[0] ?? "");
    if (!match) return false;
    const [, token = "", name = ""] = match;
    const given = Buffer.from(token);
    const expected = Buffer.from(this.token);
    const resolve = this.upstreams.get(name);
    if (given.length !== expected.length || !timingSafeEqual(given, expected) || !resolve) {
      res.writeHead(404).end();
      return true;
    }
    const upstream = await resolve().catch(() => null);
    if (!upstream) {
      res.writeHead(503, { "content-type": "text/plain" }).end(`${name} isn't connected.`);
      return true;
    }
    const headers: Record<string, string> = {};
    for (const key of REQUEST_HEADERS) {
      const value = req.headers[key];
      if (typeof value === "string") headers[key] = value;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const response = await fetch(upstream.url, {
        method: req.method ?? "GET",
        headers: { ...headers, ...upstream.headers },
        ...(hasBody
          ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" as const }
          : {}),
        signal: abort.signal,
      });
      const out: Record<string, string> = {};
      for (const key of RESPONSE_HEADERS) {
        const value = response.headers.get(key);
        if (value) out[key] = value;
      }
      res.writeHead(response.status, out);
      if (response.body) {
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
          .on("error", () => res.destroy())
          .pipe(res);
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end();
    }
    return true;
  }
}
