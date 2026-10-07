import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type DomainEvent,
  type EventBody,
  eventThreadId,
  type Item,
  type Project,
  type Thread,
  type Turn,
} from "@agentplane/contracts";

/**
 * Ordered migrations. Index + 1 is the schema version stored in `user_version`;
 * only ever append.
 */
const MIGRATIONS = [
  `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    thread_id TEXT,
    payload TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX events_thread ON events(thread_id, seq);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX threads_project ON threads(project_id);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    data TEXT NOT NULL,
    started_at INTEGER NOT NULL
  );
  CREATE INDEX turns_thread ON turns(thread_id, started_at);
  CREATE TABLE items (
    thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  );
  CREATE INDEX items_order ON items(thread_id, ord);
  `,
];

type Listener = (event: DomainEvent) => void;

/**
 * The event log plus the projections derived from it. `commit` appends events
 * and updates the projection tables in one transaction, then notifies
 * listeners, so a reader never sees a projection ahead of the log.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<Listener>();

  constructor(path: string) {
    // Threads hold code, commands and their output: keep the folder and the
    // database private to this account (and fix installs made before this).
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    }
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let version = row.user_version; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version] as string);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(bodies: EventBody[]): DomainEvent[] {
    if (bodies.length === 0) return [];
    const at = Date.now();
    const insert = this.db.prepare(
      "INSERT INTO events (type, thread_id, payload, at) VALUES (?, ?, ?, ?)",
    );
    const events = this.transaction(() =>
      bodies.map((body) => {
        const result = insert.run(body.type, eventThreadId(body), JSON.stringify(body), at);
        this.project(body);
        return { ...body, seq: Number(result.lastInsertRowid), at } as DomainEvent;
      }),
    );
    for (const event of events) {
      for (const listener of this.listeners) listener(event);
    }
    return events;
  }

  private project(event: EventBody): void {
    switch (event.type) {
      case "project.created":
        this.db
          .prepare("INSERT OR REPLACE INTO projects (id, data, created_at) VALUES (?, ?, ?)")
          .run(event.project.id, JSON.stringify(event.project), event.project.createdAt);
        return;
      case "project.deleted":
        this.db.prepare("DELETE FROM projects WHERE id = ?").run(event.projectId);
        return;
      case "thread.created":
      case "thread.updated":
        this.db
          .prepare(
            "INSERT OR REPLACE INTO threads (id, project_id, data, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            event.thread.id,
            event.thread.projectId,
            JSON.stringify(event.thread),
            event.thread.createdAt,
          );
        return;
      case "thread.deleted":
        this.db.prepare("DELETE FROM threads WHERE id = ?").run(event.threadId);
        this.db.prepare("DELETE FROM turns WHERE thread_id = ?").run(event.threadId);
        this.db.prepare("DELETE FROM items WHERE thread_id = ?").run(event.threadId);
        return;
      case "turn.updated":
        this.db
          .prepare(
            "INSERT OR REPLACE INTO turns (id, thread_id, data, started_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            event.turn.id,
            event.turn.threadId,
            JSON.stringify(event.turn),
            event.turn.startedAt,
          );
        return;
      case "item.upserted":
        this.db
          .prepare("INSERT OR REPLACE INTO items (thread_id, id, ord, data) VALUES (?, ?, ?, ?)")
          .run(event.item.threadId, event.item.id, event.item.order, JSON.stringify(event.item));
        return;
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  latestSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  maxItemOrder(): number {
    const row = this.db.prepare("SELECT MAX(ord) AS ord FROM items").get() as {
      ord: number | null;
    };
    return row.ord ?? 0;
  }

  listProjects(): Project[] {
    return this.rows<Project>("SELECT data FROM projects ORDER BY created_at");
  }

  getProject(id: string): Project | null {
    return this.row<Project>("SELECT data FROM projects WHERE id = ?", id);
  }

  listThreads(): Thread[] {
    return this.rows<Thread>("SELECT data FROM threads ORDER BY created_at DESC");
  }

  listThreadsForProject(projectId: string): Thread[] {
    return this.rows<Thread>("SELECT data FROM threads WHERE project_id = ?", projectId);
  }

  getThread(id: string): Thread | null {
    return this.row<Thread>("SELECT data FROM threads WHERE id = ?", id);
  }

  getTurns(threadId: string): Turn[] {
    return this.rows<Turn>(
      "SELECT data FROM turns WHERE thread_id = ? ORDER BY started_at",
      threadId,
    );
  }

  getTurn(id: string): Turn | null {
    return this.row<Turn>("SELECT data FROM turns WHERE id = ?", id);
  }

  getItems(threadId: string): Item[] {
    return this.rows<Item>("SELECT data FROM items WHERE thread_id = ? ORDER BY ord", threadId);
  }

  getItem(threadId: string, id: string): Item | null {
    return this.row<Item>("SELECT data FROM items WHERE thread_id = ? AND id = ?", threadId, id);
  }

  close(): void {
    this.db.close();
  }

  private rows<T>(sql: string, ...params: string[]): T[] {
    const rows = this.db.prepare(sql).all(...params) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as T);
  }

  private row<T>(sql: string, ...params: string[]): T | null {
    const row = this.db.prepare(sql).get(...params) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }
}
