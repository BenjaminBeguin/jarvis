# CLAUDE.md — Jarvis

Personal AI operating layer for builders. Electron + React desktop app on top of `@anthropic-ai/claude-agent-sdk`. Read this first before changing anything in this repo.

## Auth

Two modes, picked once in Setup and switchable from the Shell's `auth: …` badge:

- **`subscription`** — Tasks route through the user's installed `claude` CLI (`pathToClaudeCodeExecutable` on the SDK option). Bills against their Claude.ai subscription quota. Detected by probing `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, then `command -v claude`. **Preferred.**
- **`api-key`** — `ANTHROPIC_API_KEY` set from the macOS Keychain. Bills against the API account.

The choice lives in `~/.jarvis/config.json` (`{ "authMode": "subscription" | "api-key" }`). On startup, `refreshAuth()` in `electron/main/index.ts` reconciles:
- explicit choice from config takes precedence,
- otherwise default to `subscription` when the CLI is detected,
- otherwise fall back to `api-key` if a key is on file,
- otherwise show Setup.

**Never leave `ANTHROPIC_API_KEY` set in `process.env` for subscription mode** — the SDK / CLI would prefer it over OAuth. `TaskRunner.buildEnv()` strips it on every launch and re-adds it only for `api-key` mode.

## Mental model: two primitives

### 1. Tasks (the agentic loop)

**A Task = one `query()` call to the Agent SDK.** Tasks are how Jarvis runs Claude:

- Typing free text in the palette → Task (after intent routing).
- Voice command (local Whisper transcription) → transcribed → Task.
- Routine firing on cron → Task.
- Reminder / scheduled action firing → Task (with a framed prompt).
- A **Skill** is a saved Task template: `~/.jarvis/skills/<name>/SKILL.md` with frontmatter `name`, `description`, `allowed-tools`, `mcp-servers`, `model`; body is the system prompt. Built-ins are seeded by `seed.ts` and only written if missing.
- A **Routine** is `(skillId, cron, input?)`, persisted in `~/.jarvis/routines.json`, scheduled with `node-cron`.
- A **Reminder** is `(body, mode, fireAt)` persisted in `~/.jarvis/reminders.json`, scheduled with `setTimeout`. `mode='reminder'` fires a notify-style Claude turn; `mode='scheduled'` fires an action-style turn that *does* the thing. Both rehydrate on startup; past-due fire immediately.
- The palette goes through `parseIntent()` → either a `task` (run now) or a `reminder` (queue for later). Skill-pinned dispatches bypass routing.

### 2. Modules (extensions)

**Every feature the user asks for ships as a module.** Modules are code; skills are markdown. They don't compete — a module can register palette intents, source feeds, contextual actions, and may launch Tasks internally.

A module exports a `Module` from `electron/main/modules/types.ts`:

```ts
{
  id: 'quick-note',
  name: 'Quick note',
  description: '…',
  version: '1.0.0',
  intents: [
    {
      id: 'note',
      prefix: '/note',           // palette types this to invoke
      label: 'Quick note',
      placeholder: '…',
      handler: async (input, ctx) => {
        // ctx.jarvisRoot, ctx.notify(), ctx.launchTask()
      },
    },
  ],
  onLoad?(ctx) {…},
  onUnload?() {…},
}
```

Registration happens in `electron/main/index.ts` after `app.whenReady()`:
```ts
modules.setContext({ jarvisRoot, notify, launchTask });
await modules.register(quickNoteModule);
```

Built-in modules live in `electron/main/modules/<id>/index.ts` (or a single file when small, like `quick-note.ts`). The renderer learns about them via `window.jarvis.listModules()` and reacts to `onModulesChanged`. The palette automatically picks up new intents — no UI changes needed when adding a module.

**Module conventions:**
- Keep module state on disk under `~/.jarvis/<module-id>/`. Use `ctx.jarvisRoot` to build paths.
- Don't import from `electron/main/` directly except through `ModuleContext`. If you need a capability that's not on the context, add it to the context (one place to evolve).
- Don't talk to the renderer. Modules emit notifications and disk side-effects; the renderer learns about them through normal stores.
- A module that wants to launch agentic work calls `ctx.launchTask({ skillId, prompt, origin: 'api' })` and lets the existing Observatory display it.

**Future: external/community modules.** Same `Module` shape, loaded from `~/.jarvis/modules/<id>/` at runtime. Will need a sandboxed runtime (worker thread + a typed capability bridge); not built yet.

If a new feature breaks either primitive, push back before implementing.

## Process architecture

**Main process owns all state. Renderer is a pure view.** Do not move state to the renderer "because it's simpler" — it isn't, and tasks must survive window close.

- `electron/main/index.ts` — bootstrap, IPC handlers, completion notifications, lifecycle.
- `electron/main/task-runner.ts` — invokes Agent SDK `query()`, streams `SDKMessage` events.
- `electron/main/intent-router.ts` — pure-function parser for palette free-text → task / reminder / scheduled action.
- `electron/main/reminders.ts` — persistent setTimeout-based fires; rehydrates on startup.
- `electron/main/skill-store.ts` — loads + watches `~/.jarvis/skills/*/SKILL.md` (chokidar).
- `electron/main/mcp-config.ts` — loads + watches `~/.jarvis/mcp.json`.
- `electron/main/routines.ts` — `node-cron` scheduler + persistence (recurring; one-shot is in reminders).
- `electron/main/db.ts` — `better-sqlite3` (WAL, foreign keys on).
- `electron/main/secrets.ts` — keytar wrapper, macOS Keychain.
- `electron/main/seed.ts` — first-launch / missing-file seeds for skills + sample configs.
- `electron/main/windows.ts` — observatory + palette + Answer HUD `BrowserWindow`s.
- `electron/main/tray.ts` — template tray icon + live menu (running · awaiting · scheduled + abort-all).
- `electron/preload/index.ts` — `contextBridge` → `window.jarvis` API.
- `src/renderer/` — React. Hash-routed (`/observatory`, `/palette`, `/answer-hud`). Subscribes to IPC events, never holds source-of-truth state.
- `src/shared/` — types + IPC channel names used by both sides. **Anything crossing IPC lives here.**

### IPC pattern

- One-shot calls: `ipcRenderer.invoke(channel, payload)` → main returns a value. Channels are constants in `src/shared/ipc.ts`. Never typo a channel string.
- Streaming: main `webContents.send(channel, payload)`, renderer `ipcRenderer.on(channel, …)`. Implemented as `subscribe<T>` in `electron/preload/index.ts`.
- For Task event streams: renderer first calls `getTaskHistory(id)` to backfill, then subscribes to `task:event` for live deltas. Don't drop events when a window is closed — they're persisted in `task_events` and replay on remount.

### Wire format

`SDKMessage` from `@anthropic-ai/claude-agent-sdk` goes on the wire **verbatim**. Do not translate in main. Renderer rendering is in `views/TaskDetail.tsx`. If you need a new event shape, prefer extending the renderer's `renderEvent()` over inventing a wire envelope.

## File layout (user's `~/.jarvis`)

```
~/.jarvis/
  skills/<name>/SKILL.md          # frontmatter + body; body is the systemPrompt
  mcp.json                        # global MCP servers; skills opt-in by name
  mcp.json.example                # seeded on first launch
  reminders.json                  # one-shot fires; rehydrated on startup
  notes/<date>.md                 # quick-note module (global)
  notes/<project>/<date>.md       # quick-note when scoped: "/note alias: …"
  meetings/<ts>-<slug>.md         # meeting-recorder (global)
  meetings/<project>/<ts>-…       # meeting-recorder when scoped
  projects/<name>/memory/*.md     # per-project agent memory (growing scratchpad)
  routines.json            # array of routine defs, schema in routines.ts
  jarvis.sqlite            # tasks + task_events
```

Migrations live in `electron/main/db.ts` as an ordered array. **Append, never edit.**

## Build + dev

We use **pnpm** with `node-linker=hoisted` (configured in [.npmrc](.npmrc)) because `electron-vite` and `electron-builder` expect a flat `node_modules` to locate Electron's prebuilt binary and rebuild native modules. The pnpm `onlyBuiltDependencies` allowlist in `package.json` permits scripts for `electron`, `better-sqlite3`, `keytar`, `esbuild` — without it pnpm 9+ silently skips them.

Cold install on a fresh machine (Node 24 + Python 3.12 breaks node-gyp, so we always defer native builds to electron-builder):

```sh
rm -rf node_modules                            # if you ever got into a bad state
pnpm install --ignore-scripts                  # populate the tree
pnpm rebuild electron                          # downloads the prebuilt Electron binary → node_modules/electron/dist
pnpm exec electron-builder install-app-deps    # builds better-sqlite3 + keytar against Electron's Node ABI
```

Day-to-day:

- `pnpm dev` — electron-vite with HMR. Renderer dev server is pinned to **port 3010** (`strictPort: true`) in [electron.vite.config.ts](electron.vite.config.ts). Keep it in the 3006–3015 range.
- `pnpm typecheck` — runs both `tsconfig.node.json` (main + preload + shared) and `tsconfig.web.json` (renderer + shared). Run before committing.
- `pnpm build` — production build. `pnpm dist:mac` for a DMG.

`npm install` still works the same way (`postinstall` already calls `electron-builder install-app-deps`), but using both in one tree will fight over the lockfile — pick one.

## Project conventions

- **TypeScript strict, no exceptions.** No `any` unless casting through `unknown` with a comment explaining why.
- **Path aliases**: `@shared/*` (everywhere), `@renderer/*` (renderer only). Configured in both tsconfigs and `electron.vite.config.ts`.
- **No backwards-compat shims for code that hasn't shipped.** This is a personal product without external users yet; delete unused code, don't deprecate it.
- **Avoid premature abstraction.** If a Plan agent suggests an interface "for the swap to whisper.cpp later," only add the minimal seam — don't write the swap until you do it.
- **No comments restating WHAT.** Only comments for non-obvious WHY (a workaround, a hidden invariant, a constraint from the SDK).
- **Don't tie Task lifecycle to BrowserWindow lifecycle.** A common Electron mistake. Tasks live in the registry; windows just render them.

## Adding capabilities

- **Lean on Claude before reinventing.** If a behavior can ship as a SKILL.md (action item extraction, status digest, commit message drafting), put it in `electron/main/seed.ts` and let the agent loop do the work. Don't write JS-based extractors / classifiers when a skill prompt will do.
- **New IPC channel**: add constant to `src/shared/ipc.ts`, types to `src/shared/types.ts`, handler in `electron/main/index.ts:registerIpc()`, method on `electron/preload/index.ts:api`, then use from a renderer view. Don't skip the constant — typos in inline strings are the most common IPC bug.
- **New stored field on a Task**: extend `TaskSummary`, add a SQLite migration appended to `MIGRATIONS` in `db.ts`, update the insert/update queries, update the renderer.
- **New MCP integration**: don't hardcode. The user puts servers in `~/.jarvis/mcp.json`; skills opt in via `mcp-servers: [name]` in frontmatter, or `mcp-servers: ["*"]` to inherit every server in mcp.json (used by omnibus skills like `send` so adding a new channel doesn't require a skill edit). The TaskRunner resolves names against the store.
- **Claude.ai connectors are not Jarvis MCPs.** `claude mcp list` shows entries like `claude.ai Slack: ✓ Connected` — these work in Claude.ai chat and interactive Claude Code but DO NOT propagate to Agent SDK subprocess sessions (which is what `query()` runs as). For Jarvis to use a channel, it must be a local stdio MCP — either user-scoped via `claude mcp add` or in `~/.jarvis/mcp.json`. SendPage surfaces this with a `claude-ai-only` status badge so users aren't surprised.
- **New time-fired trigger**: there are two systems. `RoutineStore` is for recurring crons; `ReminderStore` is for one-shot fires (both reminders and scheduled actions). Pick the right one — don't introduce a parallel timer.
- **New module capability**: extend `ModuleContext` in `electron/main/modules/types.ts`, then implement in `setContext()` in `index.ts`. Modules never import from `electron/main/` directly except through that context.

## Phases

We follow `~/.claude/plans/hey-i-would-love-staged-dewdrop.md`:

- Phase 0 ✅ scaffolding (tray, palette, observatory, SDK pipe).
- Phase 1 ✅ skills from disk, palette picker, history filters.
- Phase 2 ✅ MCP config, routines, daily-brief seed.
- Phase 2.5 ✅ Module system + quick-note module.
- Phase 3 ✅ meeting recorder + auto-debrief skill, Answer HUD, intent router (reminders / scheduled actions), Dashboard view, /status + /next, command history, inline schedule preview.
- Phase 4 — next: skill-to-skill chaining, workflow DAG, calendar-aware briefings, whisper.cpp swap, external/community modules.

## What's _not_ in here

- No web app, no extension, no cloud sync. macOS desktop only.
- No multi-user concept. Single user, single machine.
- No analytics, telemetry, or remote logging. The user's API key and SDK traffic go directly to Anthropic.
- No login or auth UI. The Anthropic API key is the only credential and it lives in the macOS Keychain (`keytar`).

If a request implies any of the above, surface the conflict before implementing.
