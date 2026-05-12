# CLAUDE.md — Jarvis

Personal AI operating layer for builders. Electron + React desktop app on top of `@anthropic-ai/claude-agent-sdk`. Read this first before changing anything in this repo.

## Mental model: one primitive

**A Task = one `query()` call to the Agent SDK.** Everything is a Task:

- Typing in the command palette → Task.
- Voice command (Web Speech API) → transcribed → Task.
- Routine firing on cron → Task.
- A **Skill** is a saved Task template: `~/.jarvis/skills/<name>/SKILL.md` with frontmatter `name`, `description`, `allowed-tools`, `mcp-servers`, `model`, body becomes the system prompt.
- A **Routine** is `(skillId, cron, input?)`, persisted in `~/.jarvis/routines.json`, scheduled with `node-cron`.

If a new feature breaks this model, push back before implementing.

## Process architecture

**Main process owns all state. Renderer is a pure view.** Do not move state to the renderer "because it's simpler" — it isn't, and tasks must survive window close.

- `electron/main/index.ts` — bootstrap, IPC handlers, completion notifications, lifecycle.
- `electron/main/task-runner.ts` — invokes Agent SDK `query()`, streams `SDKMessage` events.
- `electron/main/task-registry.ts` — _(future)_ split out from task-runner if it gets fat.
- `electron/main/skill-store.ts` — loads + watches `~/.jarvis/skills/*/SKILL.md` (chokidar).
- `electron/main/mcp-config.ts` — loads + watches `~/.jarvis/mcp.json`.
- `electron/main/routines.ts` — `node-cron` scheduler + persistence.
- `electron/main/db.ts` — `better-sqlite3` (WAL, foreign keys on).
- `electron/main/secrets.ts` — keytar wrapper, macOS Keychain.
- `electron/main/windows.ts` — observatory + palette `BrowserWindow`s.
- `electron/main/tray.ts` — template tray icon with running indicator.
- `electron/preload/index.ts` — `contextBridge` → `window.jarvis` API.
- `src/renderer/` — React. Hash-routed. Subscribes to IPC events, never holds source-of-truth state.
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
  skills/<name>/SKILL.md   # frontmatter + body; body is the systemPrompt
  mcp.json                 # global MCP servers; skills opt-in by name
  mcp.json.example         # seeded on first launch
  routines.json            # array of routine defs, schema in routines.ts
  jarvis.sqlite            # tasks + task_events
```

Migrations live in `electron/main/db.ts` as an ordered array. **Append, never edit.**

## Build + dev

- `npm install` runs `electron-builder install-app-deps` postinstall to rebuild native modules (`better-sqlite3`, `keytar`) against Electron's Node ABI.
- If `npm install` fails on a fresh machine due to `distutils` (Python 3.12+ removed it), run `npm install --ignore-scripts` then `npx electron-builder install-app-deps`.
- `npm run dev` — electron-vite with HMR. Renderer dev server is pinned to **port 3010** (`strictPort: true`) in [electron.vite.config.ts](electron.vite.config.ts). Keep it in the 3006–3015 range.
- `npm run typecheck` — runs both `tsconfig.node.json` (main + preload + shared) and `tsconfig.web.json` (renderer + shared). Run before committing.
- `npm run build` — production build. `npm run dist:mac` for a DMG.

## Project conventions

- **TypeScript strict, no exceptions.** No `any` unless casting through `unknown` with a comment explaining why.
- **Path aliases**: `@shared/*` (everywhere), `@renderer/*` (renderer only). Configured in both tsconfigs and `electron.vite.config.ts`.
- **No backwards-compat shims for code that hasn't shipped.** This is a personal product without external users yet; delete unused code, don't deprecate it.
- **Avoid premature abstraction.** If a Plan agent suggests an interface "for the swap to whisper.cpp later," only add the minimal seam — don't write the swap until you do it.
- **No comments restating WHAT.** Only comments for non-obvious WHY (a workaround, a hidden invariant, a constraint from the SDK).
- **Don't tie Task lifecycle to BrowserWindow lifecycle.** A common Electron mistake. Tasks live in the registry; windows just render them.

## Adding capabilities

- **New IPC channel**: add constant to `src/shared/ipc.ts`, types to `src/shared/types.ts`, handler in `electron/main/index.ts:registerIpc()`, method on `electron/preload/index.ts:api`, then use from a renderer view. Don't skip the constant — typos in inline strings are the most common IPC bug.
- **New stored field on a Task**: extend `TaskSummary`, add a SQLite migration appended to `MIGRATIONS` in `db.ts`, update the insert/update queries, update the renderer.
- **New MCP integration**: don't hardcode. The user puts servers in `~/.jarvis/mcp.json`; skills opt in via `mcp-servers: [name]` in frontmatter. The TaskRunner filters by skill.
- **New scheduler trigger**: routines are the only mechanism today. Add to `RoutineStore`, not as a parallel timer somewhere else.

## Phases

We follow `~/.claude/plans/hey-i-would-love-staged-dewdrop.md`:

- Phase 0 ✅ scaffolding (tray, palette, observatory, SDK pipe).
- Phase 1 ✅ skills from disk, palette picker, history filters.
- Phase 2 ✅ MCP config, routines, daily-brief seed.
- Phase 3 — skill-to-skill chaining, workflow DAG, whisper.cpp swap.

Don't start Phase 3 work until Phase 2 is shipped and used for at least a week.

## What's _not_ in here

- No web app, no extension, no cloud sync. macOS desktop only.
- No multi-user concept. Single user, single machine.
- No analytics, telemetry, or remote logging. The user's API key and SDK traffic go directly to Anthropic.
- No login or auth UI. The Anthropic API key is the only credential and it lives in the macOS Keychain (`keytar`).

If a request implies any of the above, surface the conflict before implementing.
