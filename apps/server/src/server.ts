import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { Duplex } from "node:stream";
import {
  type ClientMessage,
  type Item,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@agentplane/contracts";
import { WebSocket, WebSocketServer } from "ws";
import { ComposioService } from "./composio.ts";
import { SERVER_VERSION, type ServerConfig } from "./config.ts";
import { DesktopAuth, SESSION_COOKIE } from "./desktop-auth.ts";
import { McpProxy } from "./mcp-proxy.ts";
import { Orchestrator, UserError } from "./orchestrator.ts";
import { ProviderKeyStore } from "./provider-keys.ts";
import { agentEnvironment } from "./providers/detect.ts";
import { AgentCatalog } from "./providers/index.ts";
import { DEVICE_COOKIE, RemoteAccess } from "./remote.ts";
import { type CallContext, createHandlers, dispatch } from "./rpc.ts";
import { RuleBook } from "./rules.ts";
import { SettingsStore } from "./settings.ts";
import { Store } from "./store.ts";
import { type Peer, Terminals } from "./terminals.ts";
import { errorMessage } from "./util.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

export type RunningServer = {
  url: string;
  /** Opening this signs a browser in (changes every start). */
  launchUrl: string;
  close: () => Promise<void>;
};

/** Requests must name this machine; anything else is DNS rebinding or a stray proxy. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Headers on every response: no framing (clickjacking), no sniffing, no referrers. */
function hardenResponse(res: ServerResponse): void {
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

/** A request handler that answers 500 instead of taking the server (and every agent) down. */
function guarded(
  name: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    hardenResponse(res);
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error: unknown) => {
        console.error(`[${name}]`, errorMessage(error));
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end();
      });
  };
}

/** Paths anyone may load: the app's code and icons, no data. */
const PUBLIC_ASSET = /^\/(assets\/|favicon|manifest|icon)/;

type Connection = {
  ws: WebSocket;
  context: CallContext & { deviceId: string | null; peer: Peer };
};

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const store = new Store(config.dbPath);
  const connections = new Set<Connection>();
  const broadcast = (message: ServerMessage) => {
    const data = JSON.stringify(message);
    for (const { ws } of connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  };
  const settings = new SettingsStore(config.settingsPath);
  let keyStore: ProviderKeyStore | null = null;
  const catalog = new AgentCatalog(config, () =>
    keyStore ? keyStore.keys() : Promise.resolve({ openrouter: null }),
  );
  keyStore = new ProviderKeyStore(
    settings,
    (keys) => catalog.agentsUsing(keys),
    () => catalog.keysChanged(),
  );
  const providerKeys = keyStore;
  // Warm the slow parts (login-shell PATH, registry, agent probes) before anyone asks.
  void agentEnvironment()
    .then(() => catalog.loadRegistry())
    .then(() => catalog.statuses())
    .then(async (statuses) => {
      // Model lists come from starting each agent; do it now, one at a time,
      // for agents installed on PATH, so pickers open instantly later.
      for (const status of statuses) {
        if (status.installed && status.source === "path") await catalog.models(status.provider);
      }
    })
    .catch((error) => console.error("[agents]", errorMessage(error)));
  const ruleBook = new RuleBook(settings);
  const desktopAuth = new DesktopAuth(settings);
  // Agents get Composio through a local proxy that holds the key.
  const mcpProxy = new McpProxy(config.port);
  const composioUrl = mcpProxy.register("composio", async () => {
    const [server] = (await composio?.toolServers()) ?? [];
    return server ? { url: server.url, headers: server.headers } : null;
  });
  // The orchestrator asks Composio for tools per session; Composio needs the
  // orchestrator to start threads from triggers. Late-bind the first edge.
  let composio: ComposioService | null = null;
  const orchestrator = new Orchestrator(
    store,
    config,
    (item: Item) => broadcast({ type: "live", item }),
    catalog.adapters,
    {
      toolServers: async () =>
        ((await composio?.toolServers()) ?? []).length > 0
          ? [{ name: "composio", url: composioUrl, headers: {} }]
          : [],
      rules: ruleBook,
      agentLabel: (id) => catalog.label(id),
      canSignIn: (id) => catalog.canSignIn(id),
      setupTrust: {
        trusted: (projectId, command) => settings.get().trustedSetups[projectId] === command,
        trust: (projectId, command) =>
          settings.update((current) => ({
            ...current,
            trustedSetups: { ...current.trustedSetups, [projectId]: command },
          })),
      },
    },
  );
  composio = new ComposioService(settings, orchestrator);
  const composioService = composio;
  void composioService.start().catch((error) => console.error("[composio]", errorMessage(error)));
  const terminals = new Terminals((threadId) => orchestrator.terminalTarget(threadId));
  store.onEvent((event) => {
    broadcast({ type: "event", event });
    if (event.type === "thread.deleted") terminals.closeThread(event.threadId);
  });

  const wss = new WebSocketServer({ noServer: true });
  const accept = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    context: Omit<Connection["context"], "peer">,
  ) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peer: Peer = {
        send: (message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        },
      };
      const connection: Connection = { ws, context: { ...context, peer } };
      connections.add(connection);
      ws.on("close", () => {
        connections.delete(connection);
        terminals.detach(peer);
      });
      serve(connection);
    });
  };
  const reject = (socket: Duplex) => {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
  };

  // ─── Phone access (off unless enabled in Settings) ────────────────────────
  let remoteServer: Server | null = null;
  const remote: RemoteAccess = new RemoteAccess(
    settings,
    {
      start: (host, port) =>
        new Promise<void>((resolve, failed) => {
          const server = createServer(guarded("remote", (req, res) => serveRemote(req, res)));
          server.on("upgrade", (req, socket, head) => {
            const device = remote.authenticate(req);
            // Paired devices only, and only from our own page (no cross-site sockets).
            const sameOrigin = originHost(req.headers.origin) === req.headers.host;
            if (req.url !== "/ws" || !device || !sameOrigin) {
              reject(socket);
              return;
            }
            accept(req, socket, head, { remote: true, deviceId: device.id });
          });
          server.once("error", failed);
          server.listen(port, host, () => {
            remoteServer = server;
            resolve();
          });
        }),
      stop: () =>
        new Promise<void>((resolve) => {
          const server = remoteServer;
          remoteServer = null;
          if (!server) return resolve();
          for (const connection of connections) {
            if (connection.context.remote) connection.ws.close();
          }
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    },
    (deviceId) => {
      for (const connection of connections) {
        if (connection.context.deviceId === deviceId) connection.ws.close(4401, "Device removed");
      }
    },
  );
  const handlers = createHandlers(
    orchestrator,
    catalog,
    composioService,
    ruleBook,
    remote,
    terminals,
    providerKeys,
  );
  void remote.start().catch((error) => console.error("[remote]", errorMessage(error)));

  const serveRemote = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://device");
    const secure = req.headers["x-forwarded-proto"] === "https";
    if (url.pathname === "/pair") {
      const token = remote.pair(url.searchParams.get("code") ?? "", req.headers["user-agent"]);
      if (!token) {
        page(
          res,
          403,
          "This pairing link has expired or was already used.",
          "Make a new one in Settings on your computer.",
        );
        return;
      }
      res.writeHead(302, {
        // Lax, not Strict: the first visit arrives from the camera app, a
        // cross-site navigation. Cross-site WebSockets still get no cookie.
        "set-cookie": `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`,
        location: "/",
      });
      res.end();
      return;
    }
    if (!PUBLIC_ASSET.test(url.pathname) && !remote.authenticate(req)) {
      page(
        res,
        401,
        "This device isn't paired yet.",
        "On your computer, open Settings → Phone and scan the QR code.",
      );
      return;
    }
    serveStatic(config, req, res);
  };

  // ─── The desktop app (loopback only) ──────────────────────────────────────
  const http = createServer(
    guarded("http", async (req, res) => {
      if (!LOOPBACK_HOST.test(req.headers.host ?? "")) {
        res.writeHead(403).end();
        return;
      }
      if (await mcpProxy.handle(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/auth") {
        const session = desktopAuth.signIn(url.searchParams.get("token") ?? "");
        if (!session) {
          page(
            res,
            403,
            "This sign-in link is out of date.",
            "The link changes every time Agentplane starts. Use the one it printed most recently.",
          );
          return;
        }
        res.writeHead(302, {
          "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          location: "/",
        });
        res.end();
        return;
      }
      if (!PUBLIC_ASSET.test(url.pathname) && !desktopAuth.authenticate(req)) {
        page(
          res,
          401,
          "Open Agentplane from its launch link.",
          "Start it with <code>pnpm start</code> and open the link it prints. This browser stays signed in after that.",
        );
        return;
      }
      serveStatic(config, req, res);
    }),
  );
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...config.devOrigins,
  ]);
  http.on("upgrade", (req, socket, head) => {
    // Browsers let any site open a WebSocket to localhost, so only our own UI
    // may connect. Checking Host as well defeats DNS rebinding.
    // Programs that aren't browsers send no Origin; they still need a session.
    const origin = req.headers.origin;
    const hostOk = LOOPBACK_HOST.test(req.headers.host ?? "");
    const originOk = origin === undefined || allowedOrigins.has(origin);
    if (req.url !== "/ws" || !hostOk || !originOk || !desktopAuth.authenticate(req)) {
      reject(socket);
      return;
    }
    accept(req, socket, head, { remote: false, deviceId: null });
  });

  const serve = ({ ws, context }: Connection) => {
    const send = (message: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    send({ type: "hello", protocolVersion: PROTOCOL_VERSION, serverVersion: SERVER_VERSION });
    ws.on("message", async (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      try {
        const result = await dispatch(handlers, message.method, message.params, context);
        send({ type: "response", id: message.id, ok: true, result });
      } catch (error) {
        if (!(error instanceof UserError)) console.error(`[rpc] ${message.method} failed:`, error);
        send({ type: "response", id: message.id, ok: false, error: errorMessage(error) });
      }
    });
  };

  await new Promise<void>((resolve, failed) => {
    http.once("error", failed);
    http.listen(config.port, config.host, () => resolve());
  });

  return {
    url: `http://${config.host}:${config.port}`,
    launchUrl: `${config.devOrigins[0] ?? `http://${config.host}:${config.port}`}/auth?token=${desktopAuth.launchToken}`,
    close: async () => {
      for (const { ws } of connections) ws.close();
      terminals.closeAll();
      await remote.stop();
      await composioService.stop();
      await orchestrator.closeAll();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      store.close();
    },
  };
}

/** The host part of an Origin header, or null if it's missing or not a URL ("null"). */
function originHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** A small self-contained page for sign-in and pairing outcomes (no app shell needed). */
function page(res: ServerResponse, status: number, title: string, detail: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agentplane</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0f0f;color:#fff;font:16px/1.5 ui-sans-serif,system-ui,sans-serif;padding:24px}
main{max-width:400px}p{color:rgba(255,255,255,.6);margin:8px 0 0}code{font:13px ui-monospace,monospace;color:#fff}small{font:11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#51a2ff}</style></head>
<body><main><small>Agentplane</small><h1 style="font-weight:400;font-size:22px;margin:8px 0 0">${title}</h1><p>${detail}</p></main></body></html>`);
}

function serveStatic(config: ServerConfig, req: IncomingMessage, res: ServerResponse): void {
  if (!config.webDistDir) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Agentplane server is running. In dev, open the Vite server at http://localhost:5173");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("Bad path");
    return;
  }
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(config.webDistDir, relative);
  if (!file.startsWith(config.webDistDir) || !existsSync(file) || statSync(file).isDirectory()) {
    // Client-side routes all render the SPA shell.
    file = join(config.webDistDir, "index.html");
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}
