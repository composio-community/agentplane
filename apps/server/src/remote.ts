import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import type { RemoteStatus } from "@agentplane/contracts";
import { which } from "./providers/detect.ts";
import type { SettingsStore } from "./settings.ts";
import { newId } from "./util.ts";

const exec = promisify(execFile);

export const DEVICE_COOKIE = "agentplane_device";
const PAIRING_TTL_MS = 10 * 60 * 1000;
export const REMOTE_PORT = 3780;

export type RemoteMode = "lan" | "tailscale";

export type Device = {
  id: string;
  name: string;
  /** sha256 of the device token; the token itself is never stored. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
};

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** This Mac's address on the local network (Wi‑Fi or Ethernet). */
export function lanAddress(): string | null {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(utun|bridge|awdl|llw|vmnet|docker|lo)/.test(name)) continue;
    const ipv4 = addresses?.find((address) => address.family === "IPv4" && !address.internal);
    if (ipv4) return ipv4.address;
  }
  return null;
}

/** A readable name for the device from its User-Agent ("iPhone · Safari"). */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "Device";
  const browser = /CriOS|Chrome/.test(ua)
    ? "Chrome"
    : /FxiOS|Firefox/.test(ua)
      ? "Firefox"
      : /Safari/.test(ua)
        ? "Safari"
        : "Browser";
  return `${device} · ${browser}`;
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

type Tailscale = { binary: string; dnsName: string | null; running: boolean };

async function findTailscale(): Promise<Tailscale | null> {
  const binary =
    (await which("tailscale")) ??
    ((await exec("/bin/test", ["-x", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]).then(
      () => "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      () => null,
    )) as string | null);
  if (!binary) return null;
  try {
    const { stdout } = await exec(binary, ["status", "--json"], { timeout: 5_000 });
    const status = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    return {
      binary,
      running: status.BackendState === "Running",
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") ?? null,
    };
  } catch {
    return { binary, running: false, dnsName: null };
  }
}

/**
 * Phone (and other device) access. Off by default; when on, a second
 * listener serves the app to paired devices only. Pairing is a one-time
 * code (shown as a QR) exchanged for a long-lived device token in an
 * HttpOnly cookie. Desktop-only settings stay desktop-only.
 */
export class RemoteAccess {
  private readonly codes = new Map<string, number>();
  private tailscale: Tailscale | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly listener: {
      start: (host: string, port: number) => Promise<void>;
      stop: () => Promise<void>;
    },
    private readonly onRevoke: (deviceId: string) => void,
  ) {}

  private get config() {
    return this.settings.get().remote;
  }

  async start(): Promise<void> {
    this.tailscale = await findTailscale();
    if (this.config.enabled) await this.listen().catch(() => this.disable());
  }

  private async disable(): Promise<void> {
    this.settings.update((settings) => ({
      ...settings,
      remote: { ...settings.remote, enabled: false },
    }));
  }

  private async listen(): Promise<void> {
    await this.listener.stop();
    const { mode, port } = this.config;
    if (mode === "tailscale") {
      if (!this.tailscale?.running) throw new Error("Tailscale isn't running on this Mac.");
      // Tailscale terminates HTTPS and forwards to a loopback-only listener.
      await this.listener.start("127.0.0.1", port);
      await exec(
        this.tailscale.binary,
        ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`],
        {
          timeout: 15_000,
        },
      );
    } else {
      const address = lanAddress();
      if (!address) throw new Error("This Mac isn't on a local network.");
      await this.listener.start(address, port);
    }
  }

  async stop(): Promise<void> {
    await this.listener.stop();
    if (this.config.mode === "tailscale" && this.tailscale) {
      await exec(this.tailscale.binary, ["serve", "--https=443", "off"], { timeout: 15_000 }).catch(
        () => undefined,
      );
    }
  }

  async configure(change: { enabled?: boolean; mode?: RemoteMode }): Promise<RemoteStatus> {
    this.tailscale = await findTailscale();
    const wasEnabled = this.config.enabled;
    if (wasEnabled) await this.stop();
    this.settings.update((settings) => ({
      ...settings,
      remote: { ...settings.remote, ...change },
    }));
    if (this.config.enabled) {
      try {
        await this.listen();
      } catch (error) {
        await this.disable();
        throw error;
      }
    }
    return this.status(false);
  }

  url(): string | null {
    if (!this.config.enabled) return null;
    if (this.config.mode === "tailscale") {
      return this.tailscale?.dnsName ? `https://${this.tailscale.dnsName}` : null;
    }
    const address = lanAddress();
    return address ? `http://${address}:${this.config.port}` : null;
  }

  status(viewerIsRemote: boolean): RemoteStatus {
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      url: this.url(),
      viewerIsRemote,
      tailscale: {
        installed: this.tailscale !== null,
        running: this.tailscale?.running ?? false,
        dnsName: this.tailscale?.dnsName ?? null,
      },
      devices: this.config.devices.map(({ tokenHash: _hash, ...device }) => device),
    };
  }

  /** A one-time pairing link (for the QR code), valid for 10 minutes. */
  pairingLink(): { url: string; expiresAt: number } {
    const base = this.url();
    if (!base) throw new Error("Turn on phone access first.");
    const now = Date.now();
    for (const [code, expires] of this.codes) if (expires < now) this.codes.delete(code);
    const code = randomBytes(24).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    this.codes.set(code, expiresAt);
    return { url: `${base}/pair?code=${code}`, expiresAt };
  }

  /** Trade a pairing code for a device token; the code can't be used again. */
  pair(code: string, userAgent: string | undefined): string | null {
    const expires = this.codes.get(code);
    this.codes.delete(code);
    if (!expires || expires < Date.now()) return null;
    const token = randomBytes(32).toString("base64url");
    const device: Device = {
      id: newId(),
      name: deviceName(userAgent),
      tokenHash: hash(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.settings.update((settings) => ({
      ...settings,
      remote: { ...settings.remote, devices: [...settings.remote.devices, device] },
    }));
    return token;
  }

  /** The paired device a request belongs to, if any. */
  authenticate(req: IncomingMessage): Device | null {
    const token = readCookie(req, DEVICE_COOKIE);
    if (!token) return null;
    const candidate = Buffer.from(hash(token));
    const device = this.config.devices.find((entry) => {
      const known = Buffer.from(entry.tokenHash);
      return known.length === candidate.length && timingSafeEqual(known, candidate);
    });
    if (!device) return null;
    if (Date.now() - device.lastSeenAt > 60_000) {
      this.settings.update((settings) => ({
        ...settings,
        remote: {
          ...settings.remote,
          devices: settings.remote.devices.map((entry) =>
            entry.id === device.id ? { ...entry, lastSeenAt: Date.now() } : entry,
          ),
        },
      }));
    }
    return device;
  }

  revoke(deviceId: string): void {
    this.settings.update((settings) => ({
      ...settings,
      remote: {
        ...settings.remote,
        devices: settings.remote.devices.filter((device) => device.id !== deviceId),
      },
    }));
    this.onRevoke(deviceId);
  }
}
