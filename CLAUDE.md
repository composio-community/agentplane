# CLAUDE.md

Local control plane for coding agents. See README.md for the architecture.

## Commands

```bash
pnpm dev        # server (tsx watch, :3773) + Vite UI (:5173); open the printed sign-in link
pnpm typecheck  # all packages
pnpm lint       # Biome; `pnpm format` to fix
pnpm spike <claude|codex> "<prompt>" [--mode supervised] [--cwd dir]   # drive one adapter, print events
```

Point `AGENTPLANE_HOME` at a scratch dir when testing so your real state isn't touched.

## Rules

- **Contracts first.** Anything crossing the wire is a zod schema in `packages/contracts`. Change the
  schema, then the server, then the UI.
- **All state changes are events.** Never write projections directly; commit `EventBody`s through
  `Store.commit`. Streaming-only updates go through the orchestrator's live channel.
- **Adapters emit whole items, not deltas,** with stable ids that stay unique across resumed
  sessions. Policy reads runtime modes and capabilities, never `provider === "x"` outside adapters.
- **No `useEffect`.** Server state lives in the zustand store fed by `lib/client.ts` outside React.
  Use route loaders, event handlers, ref callbacks, `use()`, or CSS (`flex-col-reverse` pins the
  timeline to the bottom).
- **Design system** is ported from Composio's landing repo: tokens in `apps/web/src/styles.css`.
  Use token utilities (`bg-background`, `text-brand-readable`), never raw hex. Sans is weight
  400/500 only. Mono + uppercase + `tracking-wider` (the `Eyebrow` component) carries labels.
  Primary CTAs are square, chips `rounded-xs`, cards `rounded-xl`. Dark (`.dark`) is the default.
- **Agents live in `apps/server/src/providers/`.** `index.ts` is the catalog (featured agents +
  everything in the ACP registry). New ACP agents are usually just a catalog entry; only add a
  native adapter when a protocol gives us something ACP can't. Spawn agents with
  `agentEnvironment()` (login-shell PATH, no npm/pnpm env), never `process.env`.
- **Never handle agent credentials.** Spawn the user's own `claude` / `codex` binaries; no OAuth
  flows, no token reading. Keys the user types into Settings (OpenRouter, Composio) live only in
  `settings.json` (0600) and reach agents through their environment or the local MCP proxy, never
  argv or the browser.
- The app and WebSocket need a signed-in browser session (`desktop-auth.ts`), a loopback Host and
  our own origin (`server.ts`). Keep it that way; new routes go behind the same checks.
- A paired phone can't do anything that runs code outside an agent turn or outlives its access:
  add such methods to `DESKTOP_ONLY_METHODS`.
