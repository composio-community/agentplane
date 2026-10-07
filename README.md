# Agentplane

A local control plane for coding agents. Run Claude Code, Codex, Cursor, Gemini, Pi and 35+ other
agents side by side on your own machine, each in its own git worktree. Approve what they want to
do, watch them work, and get pinged when one needs you.

> Early and moving fast; expect breaking changes.

## Quick start

You need Node 24+, pnpm, and at least one agent signed in (see [Agents](#agents)).

```bash
pnpm install
pnpm dev          # server on :3773 + UI on http://localhost:5173
```

Or run the built app from one process:

```bash
pnpm build
pnpm start        # opens http://127.0.0.1:3773 signed in
```

The server prints a launch link each time it starts (and opens it; `--no-open` skips that). Opening
it signs that browser in for good; the link itself changes every start. Anything else that reaches
`127.0.0.1:3773` without that session gets nothing: see [Security](#security).

State lives in `~/.agentplane` (override with `AGENTPLANE_HOME` or `--home`; an older `~/.orchestration` is moved there on first start). Worktrees are created
under `~/.agentplane/worktrees/<project>/<id>` on a branch named `agentplane/<id>`.

## What's in it

- **Fast.** Agents are started while you open a thread or type, so sending a message only waits
  on the model (Claude: 6.5s → 2.9s to first output; Codex: 7.7s → 2.4s). The agent list is served
  from cache and refreshed in the background.
- **Worktrees in under a second.** New threads get their own git worktree with your gitignored
  `.env` files copied and every `node_modules` cloned copy-on-write (APFS `clonefile`; reflinks on
  Linux): 561 MB of dependencies in 0.6s, no reinstall. Each thread gets its own `PORT` range so dev
  servers don't collide. Add an `agentplane.json` to run a setup command too:
  `{ "setup": "pnpm install --offline", "copy": ["config/local.yml"] }`.
- **One permission policy for every agent.** "Always allow" saves a project rule (a command family
  like `pnpm test`, all file edits, or one tool) that applies to Claude, Codex, Pi and every ACP
  agent alike. Covered requests are answered silently; chained or redirected commands never match.
- **Inbox.** Everything waiting on you across all threads, oldest first, plus what finished since you
  looked. `A` / `D` approve or deny the top request.
- **Every agent's real model list.** The model picker asks each agent what it can run (Claude's
  `supportedModels()`, Codex `model/list`, Pi `get_available_models`, ACP agents' model config), caches
  it, and lets you switch models mid-thread; the conversation carries over. Agents that can't
  answer (not signed in, not downloaded yet) say why, and you can type a model instead.
  `pnpm --filter @agentplane/server exec tsx scripts/models.ts` lists them from the terminal.
- **Switch agents anytime, keep context.** The agent in a thread's header is a dropdown: move a
  thread between Claude, Codex, Pi and any ACP agent between turns. Each agent keeps its own native
  session per thread, so switching *back* resumes that session and only sends what it missed. A new
  agent gets the thread so far: whole entries (messages, commands with output, edits with diffs,
  plans, anything you denied), newest exchange and original request first, within a budget. Codex
  receives it as native history (`thread/inject_items`); others get it ahead of your message. If an
  agent's old session can't be restored (missing transcript), the fresh one gets everything. A
  timeline divider shows each handoff.
- **A terminal per thread.** `⌘J` opens shells in the thread's folder or worktree (with its `PORT`),
  docked under the conversation or beside it, in tabs (zsh, bash, fish, whatever's installed). Shells
  keep running when you switch threads or reload.
- **Agents that need setup say how.** A sign-in or update problem shows up as a card with the
  agent's real error, a button that opens its sign-in in Terminal, "Try again", and the agents that
  are ready right now ("Use Codex instead" retries your message there).
- **Keyboard first.** `⌘K` command palette (threads, actions, permissions), `⌘J` terminal,
  `⌥↑`/`⌥↓` between threads, `Enter` to send, `Esc` to stop.
- **Composio built in.** Add a Composio API key in Settings and:
  - every agent gets the same tools for GitHub, Linear, Slack, Sentry and 1000+ apps (one MCP
    endpoint injected into Claude, Codex and ACP sessions; agents show a connect link the first time
    they need an app);
  - **automations** turn trigger events (a new Linear issue, a Sentry alert, a failing check) into
    threads with a prompt template, streamed over Composio's realtime channel, so no public URL is
    needed. "Test with a sample event" runs one without waiting.

## How it works

```
Browser / (later) Electron window
        │  one WebSocket (127.0.0.1 only, origin-checked)
        ▼
apps/server ── orchestrator ──┬── Claude adapter: Agent SDK query() → your `claude` binary
        │                     └── Codex adapter: `codex app-server` (JSON-RPC over stdio)
        ▼
SQLite (node:sqlite): append-only event log + projections
```

- **One local server owns everything.** Agent processes, git and state live in a Node process; the
  UI is a client. Close the tab and agents keep running; reopen it and it catches up.
- **One adapter shape for every agent** (`apps/server/src/providers/types.ts`). Adapters map their
  provider's native stream onto a shared timeline: messages, reasoning, tool calls, approvals,
  questions, plans, errors. Items are whole-entity snapshots, never deltas.
- **Event sourced.** Every change is a sequenced event committed with its projection in one
  transaction (`apps/server/src/store.ts`). Clients load a snapshot, then apply events by `seq`.
  Streaming text is pushed as throttled live snapshots (50 ms) and persisted once final.
- **Approvals are uniform.** Supervised runs surface each permission request as an item; the adapter
  blocks until the UI answers, then translates the decision back (Claude `canUseTool`, Codex
  `requestApproval`).

| Package | What it is |
| --- | --- |
| `packages/contracts` | Zod schemas: domain types, events, the WebSocket protocol |
| `apps/server` | Node server: orchestrator, provider adapters, git worktrees, SQLite store |
| `apps/web` | React 19 + Vite + TanStack Router + Tailwind v4 UI |

## Agents

| Agent | How we talk to it | Runs from |
| --- | --- | --- |
| Claude Code | Claude Agent SDK, using your installed `claude` | PATH |
| Codex | `codex app-server` (JSON-RPC) | PATH |
| Pi | `pi --mode rpc`, plus an injected extension for approvals | PATH |
| Google Antigravity | ACP (Google's ACP server) | Downloaded from dl.google.com on first use |
| Cursor | ACP (`cursor-agent acp`) | PATH, else ACP registry |
| Grok | ACP (`grok agent stdio`) | PATH, else ACP registry |
| OpenCode | ACP (`opencode acp`) | PATH, else ACP registry |
| Gemini CLI, Qwen Code, GitHub Copilot, Goose, Devin, Amp, Kimi | ACP | PATH, else ACP registry |
| 27 more (Cline, Auggie, Kilo, Factory Droid, Mistral Vibe, …) | ACP | [ACP registry](https://github.com/agentclientprotocol/registry) |

- **Agents on your PATH** are used as installed. PATH comes from your login shell, so the server
  sees what your terminal sees, even when started from npx/pnpm or a GUI.
- **Registry agents** run via `npx`/`uvx` or a downloaded binary, unpacked under
  `~/.agentplane/tools` and checked against the registry's sha256 when it provides one.
- **Sign-in** stays with each agent. If one needs it, its sign-in link shows up in the thread (or
  run the agent's CLI once in a terminal).
- **Or one OpenRouter key.** Add it in Settings and the open agents run on any OpenRouter model
  without a login of their own. The key goes to them in their environment:

  | Agent | On an OpenRouter key | Notes |
  | --- | --- | --- |
  | OpenCode | yes | Starts on Kimi K2.6 unless you pick a model (its own default refuses other apps) |
  | Pi | yes | Every OpenRouter model shows up in its model menu |
  | Grok | yes, when not signed in to xAI | Runs from its own profile with Grok Build, Grok 4.3, Kimi K2.6, Gemini Flash-Lite |
  | Qwen Code | yes, when not signed in to Qwen | OpenAI-compatible mode; the model is fixed per session |
  | Goose | yes | Keeps your Goose config's provider and model if you have one |
  | Claude Code, Codex, Copilot, Cursor, Gemini CLI, Antigravity, Kimi, Amp, Devin | no | Their own sign-in (Copilot uses your `gh` login) |

  Google no longer lets Gemini CLI use personal Google accounts; give it a `GEMINI_API_KEY` or use
  Antigravity. Cursor builds on PATH without ACP are swapped for the registry's current build.

`pnpm spike <agent> "<prompt>"` drives any of them headlessly; `pnpm spike custom "<prompt>" --acp
"<command>"` drives an arbitrary ACP agent, and `scripts/acp-probe.ts` dumps raw ACP traffic.

## Permissions

Each thread has a runtime mode, changeable at any time:

| Mode | Claude | Codex | ACP agents & Pi |
| --- | --- | --- | --- |
| Supervised | `default` (asks via the UI) | `untrusted` + read-only sandbox | Ask for everything but reads |
| Auto-edit | `acceptEdits` | `on-request` + workspace-write sandbox | Edits allowed, ask for the rest |
| Full access | `bypassPermissions` | `never` + no sandbox | Allow everything |

For ACP agents the policy is applied on our side when the agent asks permission, and the agent's
own mode is switched too where it has one (Antigravity, Gemini).

Use full access in a worktree.

## Security

The server can run agents and shells as you, so it treats every request as hostile until proven
otherwise:

- **Signed-in browsers only.** The app and its WebSocket need the session cookie the launch link
  sets (HttpOnly, SameSite=Strict); requests must name `127.0.0.1`/`localhost` (no DNS rebinding)
  and come from the app's own origin. Pages can't be framed.
- **Private state.** `~/.agentplane` is owner-only (`0700`), settings and the database `0600`.
- **Keys stay put.** API keys you enter (OpenRouter, Composio) never go back to the browser or onto
  an agent's command line. Agents reach Composio through a local proxy that adds the key, so a
  third-party agent never sees it.
- **Repos don't run code on their own.** A project's `agentplane.json` `setup` command waits for
  your OK in the thread (run once, or always for that exact command); `copy` can't reach outside
  the repo.
- **"Always allow" stays narrow.** Rules cover a command family (`pnpm test`), never a chained or
  redirected command; for programs that run arbitrary code (`node`, `python`, `npx`, `bash`,
  `find`, …) a rule covers only the exact command.

## Auth and terms

Agentplane never handles your agent credentials. It runs the unmodified agent CLIs you
installed and signed in to yourself (or the vendor's own ACP build from the registry). It does not offer a Claude.ai login or touch OAuth
tokens. Not affiliated with Anthropic or OpenAI.

## Development

```bash
pnpm typecheck
pnpm lint         # Biome
pnpm spike claude "Say hi" --mode supervised --cwd /tmp/somewhere
```

`pnpm spike` drives one adapter directly and prints its normalized events. It's the fastest way to
see what a provider sends after a CLI upgrade. To extend the Codex adapter, regenerate the protocol
types with `codex app-server generate-ts --out <dir>`.

## Roadmap

- [x] Claude + Codex adapters, approvals, questions, plans, interrupt, resume
- [x] Worktree per thread, event log, live streaming, reconnect, notifications
- [ ] Per-turn git checkpoints: real diffs and "revert this turn"
- [ ] Follow-ups while a turn runs (queue / steer)
- [x] Embedded terminal (tabs, any installed shell, bottom or right)
- [x] Per-project setup scripts, env file copying, port ranges per worktree
- [ ] Open in editor
- [ ] Commit / push / PR from a thread
- [x] ACP adapter + ACP registry (Antigravity, Cursor, Grok, Gemini, Copilot, OpenCode, 35+ more)
- [x] Pi over RPC
- [ ] Native OpenCode adapter (`opencode serve` HTTP API) and Cursor SDK adapter
- [ ] Electron desktop shell

## License

[Apache-2.0](LICENSE)
