import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { type Deferred, deferred } from "../util.ts";

type RpcId = number | string;
type Incoming = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export type RpcHandlers = {
  onNotification: (method: string, params: unknown) => void;
  /** A request from the server; reply with `respond` / `respondError`. */
  onRequest: (id: RpcId, method: string, params: unknown) => void;
  onExit: (error: string | null) => void;
};

/** JSON-RPC over a child process's stdio, one JSON message per line. */
export class StdioRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RpcId, Deferred<unknown>>();
  private nextId = 1;
  private stderrTail = "";
  private exited = false;

  constructor(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    handlers: RpcHandlers,
  ) {
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4_000);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: Incoming;
      try {
        message = JSON.parse(line) as Incoming;
      } catch {
        return;
      }
      this.dispatch(message, handlers);
    });
    const onGone = (error: string | null) => {
      if (this.exited) return;
      this.exited = true;
      const reason = error ?? (this.stderrTail.trim() || "process exited");
      for (const request of this.pending.values()) request.reject(new Error(reason));
      this.pending.clear();
      handlers.onExit(error ? reason : null);
    };
    this.child.on("error", (error) => onGone(error.message));
    this.child.on("exit", (code, signal) =>
      onGone(code === 0 || signal === "SIGTERM" ? null : `exited with ${code ?? signal}`),
    );
  }

  private dispatch(message: Incoming, handlers: RpcHandlers): void {
    if (message.method !== undefined && message.id !== undefined) {
      handlers.onRequest(message.id, message.method, message.params);
    } else if (message.method !== undefined) {
      handlers.onNotification(message.method, message.params);
    } else if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(
          Object.assign(new Error(message.error.message), { code: message.error.code }),
        );
      } else request.resolve(message.result);
    }
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error("The agent process has exited."));
    const id = this.nextId++;
    const response = deferred<unknown>();
    this.pending.set(id, response);
    this.send({ id, method, params });
    return response.promise as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGTERM");
  }

  private send(message: object): void {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
