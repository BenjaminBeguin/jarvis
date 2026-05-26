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
- A **Workflow** is `(trigger, pipeline)` persisted in `~/.jarvis/workflows/<id>.json`. Each pipeline step is a typed node (`http-fetch`, `transform`, `osascript`, `shell`, `inbox-write`, `notify`, `run-skill`, `mcp-call`). Compiled to an XState v5 machine at load time; the user sees flat JSON. Triggers: `cron` (auto-scheduled) or `manual` (palette / `mcp__jarvis__run_workflow` / UI). Cron expressions accept the `{businessHours}` token that resolves at fire time from `config.json.workingHours` so a single setting drives every inbox feed's schedule. Workflows that end in `inbox-write` feed the Inbox under their named source — Linear, Slack, Calendar, and the smart-curate loop all run as workflows. Persisted run history is capped at 200 rows per workflow + 30 days via a periodic prune. See [docs/workflows.md](docs/workflows.md).
- The **Inbox** aggregates source feeds (PRs, reminders, failed routines, calendar) plus workflow-written sources (slack/linear). On top of those, the `inbox-curate` skill (haiku, cron-fired during working hours) reads the raw feeds + `~/.jarvis/inbox-priorities.md` and writes `~/.jarvis/inbox/smart.json` with the top items annotated by a `why` field. The renderer pins the `'smart'` section above all others. A discoverable nudge points the user at `/inbox-calibrate` while priorities.md still has placeholder bullets.
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
- For **multi-turn / awaiting-input shapes** (e.g. a remote control module mirroring cockpit prompts), use `ctx.routePrompt` to dispatch like the palette, `ctx.awaitTurnResult` to wait for the SDK's `result` event (NOT `completed`), `ctx.sendMessageToTask` to continue the same SDK session, and `ctx.abortTask` to cancel. Read [docs/telegram.md](docs/telegram.md) for the worked example.
- For **secrets** (API tokens, etc.), do not put them in `moduleSettings` — those are plaintext in `config.json`. Add dedicated `get/set/clear` functions in `secrets.ts` (keytar account convention: `<module-id>-<purpose>`), expose them via dedicated IPC channels, and declare a `secret` field in the module's `settings.fields` so the auto-rendered Settings panel shows a "Set token / Clear" affordance. The wiring in `ModuleSettingsModal.tsx → secretHandlersFor` is hardcoded per module today — extend it when you add a new secret.
- For **cross-cutting state that's not module-scoped** (e.g. AFK mode), add it to `~/.jarvis/config.json` directly via `auth.ts`'s `loadX` / `saveX` pair, expose via dedicated IPC + preload, and broadcast on change so every consumer (tray, header, modules) stays in sync.

**Future: external/community modules.** Same `Module` shape, loaded from `~/.jarvis/modules/<id>/` at runtime. Will need a sandboxed runtime (worker thread + a typed capability bridge); not built yet.

If a new feature breaks either primitive, push back before implementing.

## Process architecture

**Main process owns all state. Renderer is a pure view.** Do not move state to the renderer "because it's simpler" — it isn't, and tasks must survive window close.

- `electron/main/index.ts` — bootstrap, IPC handlers, completion notifications, lifecycle.
- `electron/main/task-runner.ts` — invokes Agent SDK `query()`, streams `SDKMessage` events. Extends `EventEmitter` — modules subscribe via `runner.on('event'|'status'|'removed', …)` for lifecycle observation.
- `electron/main/notifier.ts` — singleton fan-out for OS notifications. All `new Notification(…)` callsites route through `notifier.post({…, source: '<source>'})`. Modules call `notifier.subscribe(handler)` to mirror events to other surfaces (Telegram bot, future watch/web). Adding a notification class = adding a `NotificationSource` enum entry.
- `electron/main/route-prompt.ts` — palette dispatch logic extracted into a shared function. The renderer's `palette:routePrompt` IPC handler AND `ctx.routePrompt` (any module) call this. Single source of truth.
- `electron/main/await-turn.ts` — `awaitTurnResult(runner, taskId)` resolves on the first `result` SDK event. Multi-turn safe (does **NOT** wait for `status='completed'`; multi-turn tasks deliberately stay `running + awaitingInput=true`).
- `electron/main/intent-router.ts` — pure-function parser for palette free-text → task / reminder / scheduled action.
- `electron/main/reminders.ts` — persistent setTimeout-based fires; rehydrates on startup. `snooze(id, msFromNow)` re-arms any reminder regardless of current status.
- `electron/main/skill-store.ts` — loads + watches `~/.jarvis/skills/*/SKILL.md` (chokidar).
- `electron/main/mcp-config.ts` — loads + watches `~/.jarvis/mcp.json`.
- `electron/main/routines.ts` — `node-cron` scheduler + persistence (recurring; one-shot is in reminders).
- `electron/main/db.ts` — `better-sqlite3` (WAL, foreign keys on).
- `electron/main/secrets.ts` — keytar wrapper, macOS Keychain. Add new credentials as `ACCOUNT_<NAME>` constants + paired `get/set/clear` functions.
- `electron/main/seed.ts` — first-launch / missing-file seeds for skills + sample configs.
- `electron/main/windows.ts` — observatory + palette + Answer HUD `BrowserWindow`s.
- `electron/main/tray.ts` — template tray icon + live menu (running · awaiting · scheduled · **AFK checkbox** + abort-all). `refreshTrayMenu()` is exported for out-of-band re-renders (when something else flips AFK).
- `electron/main/module-registry.ts` — module lifecycle. `reload(moduleId)` unloads + re-loads an enabled module so external config changes (e.g. a Keychain write) re-trigger `onLoad` without an app restart.
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
  routines.json                   # array of routine defs, schema in routines.ts
  workflows/<id>.json             # workflow defs (XState pipelines); chokidar-watched
  inbox/*.json                    # inbox feeds — smart.json (curated), user-authored
  inbox-priorities.md             # smart-inbox calibration (people / projects / topics / mutes)
  integrations.json               # OAuth account metadata (no tokens — those live in Keychain)
  intent-cache.json               # sha1→awaiting-classification cache (intent-classifier.ts)
  config.json                     # authMode, disabledModules, moduleSettings.<id>, afkMode, paused, workingHours
  jarvis.sqlite                   # tasks + task_events + activity_events + workflow_runs
```

**Secrets** live in macOS Keychain (service `app.jarvis`), not config.json.
Fixed accounts: `anthropic-api-key`, `claude-code-subscription-token`,
`jarvis-http-api-token`, `telegram-bot-token`. OAuth connectors add one
account per connected provider account: `connector-<connectorId>-<accountId>`
(JSON payload — connector decides the shape). See `electron/main/secrets.ts`.

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
- **New time-fired trigger**: there are three systems. `RoutineStore` runs recurring crons of skill tasks; `ReminderStore` is for one-shot fires (reminders + scheduled actions); `WorkflowScheduler` runs cron-triggered workflows. Pick the right one — don't introduce a parallel timer.
- **New module capability**: extend `ModuleContext` in `electron/main/modules/types.ts`, then implement in `setContext()` in `index.ts`. Modules never import from `electron/main/` directly except through that context.
- **New ambient context provider** (calendar / weather / currently-open app / anything Jarvis should "just know"): prefer the **module-owned** pattern. Register in the owning module's `onLoad` via `ctx.registerContextProvider({ name, build })` and unregister in `onUnload` via `ctx.unregisterContextProvider(name)`. Reference impls: [modules/calendar.ts](electron/main/modules/calendar.ts), [modules/reminders.ts](electron/main/modules/reminders.ts). Core-level providers (`time`, `runtime`, `recent-task`, `inbox-highlights`) live in `user-context.ts` only because they read core stores that have no natural module home. The provider's `build()` runs on EVERY task launch — must be <5ms, read RAM / cached files only, never I/O.
- **New OAuth connector** (Slack/Google/Notion/Linear-style click-to-connect): add `electron/main/oauth/connectors/<name>.ts` implementing the `Connector` interface from `electron/main/oauth/types.ts`, then register it in `electron/main/index.ts` next to `googleConnector`. The orchestrator, loopback callback (`/oauth/callback/<name>` on port 4747), Keychain (`connector-<name>-<accountId>`), token refresher, and Integrations UI all pick it up automatically. Dev-side OAuth app registration steps (Google Cloud Console, Slack app, Notion integration, Linear app) and distribution caveats (Google verification, Slack App Directory) live in [docs/integrations.md](docs/integrations.md) — keep that doc current when you add a provider.
- **New workflow node type**: drop a `fromPromise` actor under `electron/main/workflow-nodes/<type>.ts`, register it in `workflow-nodes/index.ts`, add the type literal to `WorkflowNodeType` in `src/shared/types.ts`, and (optionally) extend the Step inspector's `NodeDetail.tsx` to render the params nicely. The compiled XState machine forwards `AbortSignal` into your actor automatically. See [docs/workflows.md](docs/workflows.md).
- **Every new action gets palette + MCP coverage.** If a feature is worth running, it should be reachable from the palette (a `/<prefix>` intent on a module) AND from the Jarvis MCP server (`mcp__jarvis__<tool>`). Workflows are the canonical example — `/wf <id>`, `mcp__jarvis__run_workflow({ id })`, and the UI "Run now" button all land at the same `workflowRunner.run()`.
- **Pause is a hard silencer.** Anything that fires automatically (cron, scheduled actions, calendar proximity, inbox auto-refresh, reminder fires, the notifier itself for auto sources) consults `loadPaused()` and skips. User-driven palette/voice/Telegram dispatches still work — pause is about *unattended* work. New auto sources MUST gate on pause.
- **No-data autopilot turns are skipped.** The `run-skill` workflow node auto-short-circuits when the prompt template references `{prev}` but `prev` is empty (null/[]/{}/''). So an autopilot PR-review-non-team tick on a day with no external PRs doesn't fire Claude with a hollow template — it returns `''` and the rest of the pipeline (parse → draft-write) naturally no-ops. Opt out per node via `runOnEmptyPrev: true` if a skill genuinely should fire with no input.
- **Model tiers, not pinned model ids.** New skills should declare `tier: fast | balanced | smart` in their frontmatter instead of `model: claude-x-y-z`. Tiers resolve to concrete models via [`electron/main/model-tiers.ts`](electron/main/model-tiers.ts) (fast → haiku, balanced → sonnet, smart → opus). The user's global `speedBias` preference (`auto` / `prefer-fast` / `prefer-smart` / `force-<tier>`) — Settings → Notifications → Model speed — adjusts every tier in one knob. Explicit `model:` still wins when set (intent override), so skills that genuinely need a specific model can pin it. Resolution lives in `task-runner.ts` at the SDK options assembly site. Default tier when neither `model:` nor `tier:` is set: `balanced`.
- **Mid-flight escalation.** `TaskRunner.escalate(taskId, { targetTier?, reason? })` aborts the current SDK query and resumes the same session on a higher tier — the same conversation continues with a smarter model. Two entry points: the ↑ Escalate button on a running task's header (manual) and the `mcp__jarvis__think_harder({task_id, reason, target_tier?})` MCP tool (agent-driven; the agent calls this when it realises it's over its head). The system prompt gains a `## Self-reference` section with the current task id so the agent has something to pass. After escalation, `tierOverride` is stamped on the TaskRecord and wins over every other model-resolution path, so subsequent turns stay on the upgraded tier.
- **Learning loop closes via daily-learn.** A `daily-learn` skill fires at 18:00 weekdays (workflow `daily-learn-loop`, default enabled). It reads the day's activity feed + dismissals + draft outcomes + task escalations + repeated prompts + the user's explicit config files, then writes `~/.jarvis/learnings/<date>.md` (audit journal) + `~/.jarvis/learnings/inferred-priorities.md` (running 14-day view). Critically, **`inbox-curate` and `work-awareness` skills now read inferred-priorities.md alongside the user's explicit priorities files** — so the substrate gets sharper from observed behaviour without auto-applying anything (user's explicit config always wins on conflicts). See [docs/daily-learn.md](docs/daily-learn.md).
- **Free-text + `/ask` use the Jarvis assistant persona.** Palette free-text (no slash prefix) and the `/ask` intent in `askModule` route to a no-skill task using the sharpened `DEFAULT_SYSTEM_PROMPT` in `task-runner.ts`. That prompt explicitly tells the agent: pick ONE thing for "what should I do" questions, cite specific evidence (PR #s, meeting timestamps), read `~/.jarvis/learnings/inferred-priorities.md` when synthesising, escalate via `mcp__jarvis__think_harder` for hard reasoning. The injected context block (calendar / inbox / runtime / recent tasks / project) carries the user-specific state. Tune the persona in the DEFAULT_SYSTEM_PROMPT constant — every free-text dispatch (palette / voice / mobile / Telegram) inherits it automatically.
- **Morning brief fires on its own.** Workflow `morning-brief-loop` fires `today-focus` at 08:15 weekdays (default enabled). The skill writes two files: the full markdown brief to `~/.jarvis/briefings/today-focus/<YYYY-MM-DD>.md` (Briefings tab) AND a single inbox item to `~/.jarvis/inbox/today-focus.json` carrying the recommended next move (Inbox tab, picked up by smart-curate). Notification fans out at end of pipeline so the user knows it's ready. Module wrapper exposes `/morning-brief` (run now) + `/open-brief` (reveal latest in Finder).
- **Long-lived state needs housekeeping.** The TaskRunner sweeps orphaned `status='running'` tasks every 5 min (30-min idle cutoff) BUT explicitly skips `awaitingInput=true` tasks — multi-turn sessions deliberately stay running between replies, so a user taking an hour to come back isn't a ghost. Workflow run history prunes hourly to 200/workflow + 30 days. When adding a new long-lived registry, plan the eviction up front — see `task-runner.ts:sweepOrphans` and `db.ts:pruneWorkflowRuns` for templates.
- **Internal worker sessions stay off the Observatory.** Anything that calls `query()` directly (the intent classifier today; future workers) must register its `system/init` session id via `runner.registerInternalSessionId(id)` so claude-code-watch's `isOwnedSessionId()` filter skips the resulting `~/.claude/projects/` jsonl. Otherwise every worker turn appears as a "jarvis · session XXX" row.

## Phases

We follow `~/.claude/plans/hey-i-would-love-staged-dewdrop.md`:

- Phase 0 ✅ scaffolding (tray, palette, observatory, SDK pipe).
- Phase 1 ✅ skills from disk, palette picker, history filters.
- Phase 2 ✅ MCP config, routines, daily-brief seed.
- Phase 2.5 ✅ Module system + quick-note module.
- Phase 3 ✅ meeting recorder + auto-debrief skill, Answer HUD, intent router (reminders / scheduled actions), Dashboard view, /status + /next, command history, inline schedule preview.
- Phase 3.5 ✅ Telegram bot module (pilot from phone) + AFK mode + notifier singleton + `ctx.routePrompt` / `awaitTurnResult` / `sendMessageToTask` / `abortTask` capabilities + `secret` settings field type. See [docs/telegram.md](docs/telegram.md).
- Phase 4 ✅ Workflows — XState-backed JSON pipelines (`http-fetch` → `transform` → `inbox-write` etc.), graph-first UI with React Flow, palette `/wf` + `mcp__jarvis__run_workflow` access surfaces. Linear / Slack / Calendar inbox feeds run as workflows. See [docs/workflows.md](docs/workflows.md).
- Phase 4.5 ✅ Smart inbox — `inbox-curate` skill on haiku reads raw feeds + `inbox-priorities.md` calibration and writes a ranked + annotated Smart section to the Inbox. `/inbox-calibrate` refines priorities conversationally; nudge surfaces the loop on first run. Working-hours preference (`config.json.workingHours` + `{businessHours}` cron token) drives every inbox feed's cadence. Task-runner orphan sweep + workflow-run history pruning keep long-lived state bounded.
- Phase 4.75 ✅ Mobile PWA — touch-tuned Inbox + Threads + Dictate + Reply composer + Web Push, served from the existing `/mobile` route over Tailscale. HTTP server binds `0.0.0.0:4747`; SSE pushes status + notifs + task transitions; VAPID fan-out mirrors every `notifier.post()` to subscribed phones. Pairing is a QR in Settings → Mobile (`{ baseUrl, token }` base64). See [docs/mobile.md](docs/mobile.md).
- Phase 4.8 ✅ Work-awareness loop — ambient watcher that synthesises recent signal across Slack / GitHub / Linear / Notion / meeting transcripts / notes / reminders / activity into a "your attention" Inbox section every 30 min during working hours. Output is its own inbox source (`work-awareness.json`); the `inbox-curate` haiku picks it up alongside the raw feeds. Shape via [`~/.jarvis/work-awareness-priorities.md`](docs/work-awareness.md). The skill also emits a `dismissals: []` list when it can infer items are done (e.g. you sent the Slack reply the action was waiting on) — wired into `InboxDismissalStore` in a follow-up commit.
- Phase 5 — next: skill-to-skill chaining, branching/parallel in workflows, calendar-aware briefings, whisper.cpp swap, external/community modules.

## What's _not_ in here

- No web app, no extension, no cloud sync. macOS desktop only.
- No multi-user concept. Single user, single machine.
- No analytics, telemetry, or remote logging. The user's API key and SDK traffic go directly to Anthropic.
- No login or auth UI. The Anthropic API key is the only credential and it lives in the macOS Keychain (`keytar`).

If a request implies any of the above, surface the conflict before implementing.
