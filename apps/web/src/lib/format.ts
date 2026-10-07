import type { AgentProtocol, RuntimeMode, Usage } from "@agentplane/contracts";

export const RUNTIME_MODES: Array<{ value: RuntimeMode; label: string; title: string }> = [
  {
    value: "supervised",
    label: "Supervised",
    title: "Ask before running commands or editing files",
  },
  { value: "auto-edit", label: "Auto-edit", title: "Edit files freely, ask before commands" },
  { value: "full-access", label: "Full access", title: "Never ask. Use in a worktree." },
];

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : new Date(timestamp).toLocaleDateString();
}

export function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function usageLabel(usage: Usage): string {
  return `${compactNumber(usage.inputTokens)} in · ${compactNumber(usage.outputTokens)} out`;
}

export function costLabel(costUsd: number): string {
  return costUsd < 0.01 ? "<$0.01" : `$${costUsd.toFixed(2)}`;
}

export function shortenPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+|^\/home\/[^/]+/)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

export const PROTOCOL_LABEL: Record<AgentProtocol, string> = {
  native: "Native",
  acp: "ACP",
  rpc: "RPC",
};
