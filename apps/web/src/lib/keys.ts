import { router } from "../router.tsx";
import { client } from "./client.ts";
import { appStore, orderedThreads, waitingRequests } from "./store.ts";
import { toggleTerminal } from "./terminal-state.ts";
import { setPalette, useUi } from "./ui.ts";

/** The thread open in the URL, if any. */
export function currentThreadId(): string | null {
  return /^\/t\/([^/]+)/.exec(router.state.location.pathname)?.[1] ?? null;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function moveThread(step: 1 | -1): void {
  const threads = orderedThreads(appStore.getState());
  if (threads.length === 0) return;
  const index = threads.findIndex((thread) => thread.id === currentThreadId());
  const next = threads[(index + step + threads.length) % threads.length] ?? threads[0];
  if (next) void router.navigate({ to: "/t/$threadId", params: { threadId: next.id } });
}

/**
 * App-wide shortcuts, registered once at startup (not per component):
 * ⌘K / Ctrl+K command palette, ⌘J / Ctrl+J terminal, ⌥↑ / ⌥↓ previous / next thread.
 */
export function registerShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    // In a terminal, Ctrl and Option keys belong to the shell (Ctrl+K, Ctrl+J,
    // ⌥-arrows); only ⌘ shortcuts reach the app.
    const inTerminal = event.target instanceof Element && event.target.closest(".xterm") !== null;
    const mod = event.metaKey || (event.ctrlKey && !inTerminal);
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setPalette(!useUi.getState().palette);
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
      const threadId = currentThreadId();
      if (!threadId) return;
      event.preventDefault();
      toggleTerminal(threadId);
      return;
    }
    if (
      event.altKey &&
      !mod &&
      !inTerminal &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      moveThread(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    // Inbox: A approves and D denies the oldest waiting approval.
    const key = event.key.toLowerCase();
    if (
      (key === "a" || key === "d") &&
      !mod &&
      !event.altKey &&
      router.state.location.pathname === "/inbox" &&
      !isTyping(event.target)
    ) {
      const first = waitingRequests(appStore.getState()).find(
        (entry) => entry.request.kind === "approval",
      );
      if (!first) return;
      event.preventDefault();
      void client
        .request("approval.respond", {
          threadId: first.thread.id,
          itemId: first.request.id,
          decision: key === "a" ? "approve" : "deny",
        })
        .catch(() => undefined);
    }
  });
}
