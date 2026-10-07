import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { CommandPalette } from "./components/command-palette.tsx";
import { Dialogs } from "./components/dialogs.tsx";
import { Home } from "./components/home.tsx";
import { Inbox } from "./components/inbox.tsx";
import { loadSettings, SettingsPage } from "./components/settings.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { ThreadView } from "./components/thread-view.tsx";
import { Eyebrow } from "./components/ui.tsx";
import { client, loadThread } from "./lib/client.ts";
import { markSeen, useApp } from "./lib/store.ts";

function AppShell() {
  const connection = useApp((state) => state.connection);
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {connection === "disconnected" ? (
          <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-5 py-1.5">
            <Eyebrow className="text-warning">Reconnecting</Eyebrow>
            <span className="text-caption text-foreground/60">
              Lost the local server. Agents keep running; this view catches up on reconnect.
            </span>
          </div>
        ) : null}
        <Outlet />
      </main>
      <Dialogs />
      <CommandPalette />
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/t/$threadId",
  loader: async ({ params }) => {
    await loadThread(params.threadId);
    markSeen(params.threadId);
    // Start the agent now so the first message doesn't wait for it to boot.
    void client.request("thread.prewarm", { threadId: params.threadId }).catch(() => undefined);
  },
  component: function ThreadRoute() {
    const { threadId } = threadRoute.useParams();
    return <ThreadView key={threadId} threadId={threadId} />;
  },
  errorComponent: ({ error }) => (
    <div className="grid flex-1 place-items-center text-body-sm text-foreground/50">
      {error instanceof Error ? error.message : String(error)}
    </div>
  ),
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: Inbox,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  loader: () => loadSettings(),
  component: function SettingsRoute() {
    return <SettingsPage data={settingsRoute.useLoaderData()} />;
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, threadRoute, inboxRoute, settingsRoute]),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
