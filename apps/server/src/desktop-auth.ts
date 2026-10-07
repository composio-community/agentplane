import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { readCookie } from "./remote.ts";
import type { DesktopSession, SettingsStore } from "./settings.ts";
import { newId } from "./util.ts";

export const SESSION_COOKIE = "agentplane_session";
/** Signed-in browsers kept; the oldest drop off. */
const MAX_SESSIONS = 20;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Who may use the app on this computer. The server can run shells, so
 * loopback alone isn't enough: other accounts and sandboxed apps can reach
 * 127.0.0.1 too. Each start makes a launch token (printed and opened by the
 * CLI, like Jupyter's); opening the link trades it for a long-lived browser
 * session in an HttpOnly cookie. Only hashes of session tokens are stored.
 */
export class DesktopAuth {
  /** Valid for this run of the server. */
  readonly launchToken = randomBytes(32).toString("base64url");

  constructor(private readonly settings: SettingsStore) {}

  /** Trade the launch token for a session token, or null if it's wrong. */
  signIn(token: string): string | null {
    if (!sameSecret(token, this.launchToken)) return null;
    const session = randomBytes(32).toString("base64url");
    const now = Date.now();
    const entry: DesktopSession = {
      id: newId(),
      tokenHash: hash(session),
      createdAt: now,
      lastSeenAt: now,
    };
    this.settings.update((settings) => ({
      ...settings,
      desktop: { sessions: [...settings.desktop.sessions, entry].slice(-MAX_SESSIONS) },
    }));
    return session;
  }

  authenticate(req: IncomingMessage): boolean {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const candidate = hash(token);
    const session = this.settings
      .get()
      .desktop.sessions.find((entry) => sameSecret(entry.tokenHash, candidate));
    if (!session) return false;
    if (Date.now() - session.lastSeenAt > 60 * 60 * 1000) {
      this.settings.update((settings) => ({
        ...settings,
        desktop: {
          sessions: settings.desktop.sessions.map((entry) =>
            entry.id === session.id ? { ...entry, lastSeenAt: Date.now() } : entry,
          ),
        },
      }));
    }
    return true;
  }
}
