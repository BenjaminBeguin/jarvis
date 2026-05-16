# Jarvis

Personal AI operating layer for builders. macOS Electron app on top of the
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
Voice + text palette → Claude agents → captures (notes, reminders), routines,
integrations. Always-on tray. Always-on global hotkey.

```
⌘⇧J              open the command palette
⌘1..5            tabs: Dashboard / Observatory / Inbox / Routines / Skills
⌘[  ⌘]           browser-style back / forward through the views you visited
```

## Getting started

```sh
nvm use                                       # node 20
pnpm install --ignore-scripts                 # populate node_modules
pnpm rebuild electron                         # download the Electron binary
pnpm exec electron-builder install-app-deps   # build native deps (better-sqlite3, keytar) against Electron's ABI
pnpm dev                                      # electron-vite with HMR (port 3010)
```

We use `pnpm` with `node-linker=hoisted` ([.npmrc](.npmrc)) because
`electron-vite` and `electron-builder` expect a flat `node_modules`. The
`onlyBuiltDependencies` allowlist in [package.json](package.json) permits
install scripts for `electron`, `better-sqlite3`, `keytar`, `esbuild` — without
it, pnpm 9+ silently skips them.

`npm install` works too (`postinstall` already calls `electron-builder
install-app-deps`), but don't mix lockfiles.

### First-launch auth

On first launch Jarvis offers two auth options:

- **Subscription** — if `claude` CLI is installed and you ran `claude login`,
  Jarvis routes every task through it so they bill against your Claude.ai
  subscription quota. **Preferred — no API key needed.**
- **API key** — stored in the macOS Keychain via `keytar`. Bills against
  your Anthropic API account.

Switch any time from the auth-mode pill in the top-right of the main window.
Auth flows through `electron/main/auth.ts`; the active mode is in
`~/.jarvis/config.json`.

## The mental model

Jarvis is built around a small set of primitives. They compose.

- **Task** — one call to `query()` from the Agent SDK. Everything that runs
  Claude is a Task: a palette dispatch, a routine fire, a scheduled action.
  Streamed events go on the wire verbatim; the Observatory renders them.
- **Skill** — a `SKILL.md` file under `~/.jarvis/skills/<name>/`. Frontmatter
  declares `name`, `description`, `allowed-tools`, `mcp-servers`, `model`;
  body is the system prompt. A Task that targets a skill gets the body
  prepended. Built-ins are seeded by [seed.ts](electron/main/seed.ts) on first
  launch and never re-written if you've edited them.
- **Module** — TypeScript code shipped with the app that registers palette
  intents (`/note`, `/send`, `/remind`, …), optional renderer pages (Notes,
  Calendar, Meetings, Reminders), and optional **schema-driven settings** that
  appear automatically in Settings → Modules. See
  [electron/main/modules/types.ts](electron/main/modules/types.ts) for the
  shape, [electron/main/modules/quick-note.ts](electron/main/modules/quick-note.ts)
  for a worked example with all three.
- **Routine** — `(skillId, cron, input?)` persisted in
  `~/.jarvis/routines.json`. The `node-cron` scheduler in
  [routines.ts](electron/main/routines.ts) fires the skill on cadence.
- **Reminder** — persisted in `~/.jarvis/reminders.json`. Two modes:
  - **`reminder`** (nudge): fires a macOS notification + Activity log row.
    No Claude. The reminder stays in the Inbox until you click `✓ Done`.
  - **`scheduled`** (action): spawns a Task with the body as the prompt.
  - Either mode can be **recurring** when the input includes "every Monday
    at 9am" / "daily at 17:00" / "every weekend" — the store reschedules on
    each fire instead of moving to `fired`.
- **Project** — a named codebase scope (name + aliases + repo + path). The
  active project's path becomes the cwd for new tasks, its memory files get
  loaded into context, the Inbox PR sources scan its repo. Pick scope from
  the dropdown in the top-right.
- **Inbox** — aggregated "things waiting on you" from multiple sources: PR
  reviews, PR comments, reminders, failed routines, calendar (if enabled),
  dedupe suggestions, any skill that writes `~/.jarvis/inbox/<name>.json`.
  See [docs/scenarios.md](docs/scenarios.md) for the file-source pattern.
- **Activity** — append-only SQLite log of side-effects: notes created /
  archived / deleted, meetings, integration toggles, reminders fired /
  done, MCP enable/disable. Surfaces in the Activity panel (clock icon,
  top-right). Distinct from Tasks — same panel merges both.
- **MCP server** — external tool integration (Slack, Gmail, Linear, GitHub,
  Calendar). Configured per-skill via `mcp-servers:` frontmatter or
  globally via Integrations. Two-tier:
  - **Stdio MCPs** in `~/.jarvis/mcp.json` propagate to every Task.
  - **Claude.ai-hosted MCPs** (`claude mcp list` source `claude.ai`) work
    in Claude.ai chat but do **not** propagate to Agent SDK subprocesses,
    i.e. they don't reach Jarvis tasks. Surfaced with a `claude.ai-only`
    badge in Integrations.
- **Jarvis MCP** — in-process MCP server registered automatically with
  every task. Lets agents call back into Jarvis via tools like
  `mcp__jarvis__notify`, `log_activity`, `create_reminder`, `open_url`,
  `get_active_project`. See [electron/main/jarvis-mcp.ts](electron/main/jarvis-mcp.ts)
  for the tool list. Settings → API has the full reference.

If a new feature breaks any of these primitives, push back before
implementing.

## Process architecture

**Main owns all state. Renderer is a pure view.** Tasks must survive window
close.

- `electron/main/index.ts` — bootstrap, store wiring, IPC, fan-out.
- `electron/main/task-runner.ts` — `query()` invocation, event stream.
- `electron/main/jarvis-mcp.ts` — host-side MCP, always injected.
- `electron/main/intent-router.ts` — pure parser for palette free-text.
  Handles "in 2h", "tomorrow at 9", "at 17:30", "every Monday at 9am".
- `electron/main/inbox.ts` + `inbox-sources/*` — source aggregator.
- `electron/main/activity-store.ts` — append-only event log (SQLite).
- `electron/main/module-registry.ts` — module lifecycle, settings storage.
- `electron/main/skill-store.ts` — loads + watches `~/.jarvis/skills/`.
- `electron/main/mcp-config.ts` — loads + watches `~/.jarvis/mcp.json`.
- `electron/main/routines.ts` — `node-cron` + `routines.json`.
- `electron/main/reminders.ts` — `setTimeout`-based fires, recurring support.
- `electron/main/db.ts` — `better-sqlite3` (WAL, foreign keys on). Migrations
  are append-only.
- `electron/main/windows.ts` — Observatory, Palette, Answer HUD.
- `electron/preload/index.ts` — `contextBridge` → `window.jarvis` API. Any
  channel that crosses IPC has its constant in [src/shared/ipc.ts](src/shared/ipc.ts).
- `src/renderer/` — React. Hash-routed (`/observatory`, `/palette`, `/answer-hud`).
- `src/shared/` — types + IPC channel names shared by both sides.

### IPC pattern

- One-shot: `ipcRenderer.invoke(channel, payload)` → main returns a value.
- Streaming: main `webContents.send(channel, payload)`, renderer
  `ipcRenderer.on(channel, …)` via the `subscribe<T>` helper in preload.
- Task event streams: renderer calls `getTaskHistory(id)` to backfill, then
  subscribes to `task:event` for live deltas. Persisted in `task_events`;
  events replay on remount.

`SDKMessage` from the Agent SDK goes on the wire **verbatim** — no
translation in main. Renderer rendering is
[views/TaskDetail.tsx](src/renderer/views/TaskDetail.tsx).

## File layout (your `~/.jarvis`)

```
~/.jarvis/
  skills/<name>/SKILL.md          # skills (frontmatter + body → system prompt)
  mcp.json                        # stdio MCP servers (Slack, Gmail, Linear, …)
  mcp.json.example                # seeded on first launch
  routines.json                   # cron-driven skill fires
  reminders.json                  # one-shot + recurring reminders
  notes/<date>.md                 # quick-note module (global)
  notes/<project>/<date>.md       #   when scoped via "alias: …"
  meetings/<ts>-<slug>.md         # meeting-recorder (global)
  meetings/<project>/<ts>-…       #   when scoped
  projects/<name>/memory/*.md     # per-project agent memory
  inbox/<source>.json             # user-source files (calendar, slack-pulse, …)
  inbox/.dismissed.json           # snooze state, expires automatically
  secrets/google-<identity>/      # OAuth tokens per Gmail/Calendar account
  config.json                     # auth mode, disabled modules, prefs
  preferences.md                  # markdown overlay prepended to every system prompt
  team.md                         # team context surfaced to recap/retro skills
  slack-watchlist.md              # channels + people slack-pulse scans
  jarvis.sqlite                   # tasks, task_events, activity_events
```

## Day-to-day workflow

The big six the palette dispatches:

| Palette / voice                | What it does                                                 |
|--------------------------------|--------------------------------------------------------------|
| `/note <text>`                 | Append to today's notes file (optionally scoped)             |
| `/remind <body with time>`     | Create a reminder (recurring if "every …")                   |
| `/send <recipient + channel>`  | Slack / Gmail / iMessage via connected MCPs                  |
| `/meeting [title]`             | Start a recording, transcribe + auto-debrief on stop         |
| `/review-prs`                  | Walk through PRs assigned to you                             |
| `/stale-pr-nudge`              | Find your own PRs that haven't been reviewed and draft pings |

Or just type free text — the intent router parses it. "remind me in 2h to
ship" creates a reminder; "in 2h, send the email to Luca" creates a
scheduled action.

## Settings

`Settings` lives under the auth-mode pill in the top-right (not in the tab
bar). Sections:

- **General** — auth mode + token management.
- **Preferences** — markdown editor for `~/.jarvis/preferences.md` (prepended
  to every system prompt).
- **Notifications** — when an agent asks for input (silent / toast / open
  conversation) and when a command launches a task.
- **Inbox** — source enable/disable, calendar window hours, PR scope per
  project.
- **Modules** — module enable/disable + per-module settings panels rendered
  from each module's `settings.fields` schema.
- **Integrations** — MCP catalog + custom MCP + `~/.jarvis/mcp.json` editor.
- **API** — localhost HTTP API URL + token + Jarvis MCP tool reference.

## Build a standalone app

```sh
pnpm dist:mac
```

DMGs land in `release/`. Notarization is not configured by default — add
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` env vars
before `dist:mac` when you're ready to ship.

## Conventions

- **TypeScript strict, no exceptions.** No `any` unless casting through
  `unknown` with a comment explaining why.
- **Path aliases**: `@shared/*` (everywhere), `@renderer/*` (renderer only).
- **No backwards-compat shims for code that hasn't shipped.** Personal product,
  no external users yet.
- **No comments restating WHAT.** Comments for non-obvious WHY only.
- **Don't tie Task lifecycle to BrowserWindow lifecycle.** Common Electron
  mistake. Tasks live in the registry; windows just render them.
- **`pnpm typecheck`** runs both `tsconfig.node.json` and `tsconfig.web.json`
  — run before committing.

## What's not in here

- No web app, no extension, no cloud sync. macOS desktop only.
- No multi-user concept. Single user, single machine.
- No analytics, telemetry, or remote logging. Your API key + SDK traffic go
  directly to Anthropic.
- No login. The Anthropic credential is the only one, in macOS Keychain.

## See also

- [CLAUDE.md](CLAUDE.md) — instructions for AI agents working on this repo.
- [ROADMAP.md](ROADMAP.md) — what's done, what's next.
- [docs/attention.md](docs/attention.md) — the three time-axes framing
  + the Now contract + what's still open. Read this first if you're
  evolving the synthesis surfaces.
- [docs/cli.md](docs/cli.md) — the `jarvis` CLI that reads the HTTP token
  from Keychain (no env vars needed).
- [docs/scenarios.md](docs/scenarios.md) — patterns for inbox sources,
  custom skills, routine cookbook.
- [docs/NEXT.md](docs/NEXT.md) — open ideas / design notes.
