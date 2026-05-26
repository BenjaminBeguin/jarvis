# Memory — where Jarvis remembers things

Jarvis is local-first; everything it knows about you lives on your Mac.
This is the map: every file, Keychain entry, SQLite table, and
in-memory store, organised by owner.

Two sources of truth keep this honest:

1. **Modules declare their own storage** via `Module.memory` (typed in
   [`electron/main/modules/types.ts`](../electron/main/modules/types.ts)).
   The declarations surface in **Settings → Modules → [module] → "Where
   this lives"**. New modules should declare; the UI gets discovery for
   free.
2. **Core storage** (anything not owned by a module) is documented
   below.

If you ever wonder "did Jarvis save that?" — open the module's tile in
Settings or grep this file.

## Where everything sits

```
~/.jarvis/                          # all user data (besides Keychain + SQLite)
  config.json                       # core — auth mode, AFK, paused, working hours, module prefs
  skills/<name>/SKILL.md            # core — skill bodies (frontmatter + system prompt)
  projects.json                     # core — project list (name, aliases, repo, path)
  projects/<slug>/memory/*.md       # core — per-project growing scratchpad + profile
  inbox/*.json                      # core — feeds: pr, slack, linear, calendar, smart, reminders
  inbox-priorities.md               # core — smart-inbox calibration (people / projects / topics)
  triage-policy.md                  # core — drafts triage rules (people / archive / topics / tone)
  workflows/<id>.json               # core — workflow defs (chokidar-watched)
  routines.json                     # core — recurring crons of skill tasks
  reminders.json                    # MODULE: reminders — one-shot + recurring fires
  notes/<YYYY-MM-DD>.md             # MODULE: quick-note — global daily journal
  notes/<project>/<YYYY-MM-DD>.md   # MODULE: quick-note — per-project journal
  meetings/<ts>-<slug>.md           # MODULE: meeting-recorder — global transcripts
  meetings/<project>/<ts>-<slug>.md # MODULE: meeting-recorder — per-project transcripts
  models/                           # MODULE: voice — Whisper ONNX cache (~150 MB)
  integrations.json                 # core — OAuth account metadata (no tokens)
  mcp.json                          # core — global MCP server registry
  intent-cache.json                 # core — sha1 → classification cache
  push-subscriptions.json           # core — Web Push device subscriptions (mobile PWA)
  skill-suggestions.json            # MODULE: skill-suggester — pending/accepted/dismissed
  .skill-batch.json                 # MODULE: skill-suggester — transient drop file

~/Library/Application Support/jarvis/
  jarvis.sqlite                     # core — tasks, task_events, activity_events, workflow_runs

~/.claude/projects/<project>/<sessionId>.jsonl
                                    # MODULE: claude-code-watch — Anthropic-owned;
                                    #         we only TAIL, never write

macOS Keychain (service `app.jarvis`)
  anthropic-api-key                 # core — API mode credential
  claude-code-subscription-token    # core — Subscription mode oauth token
  jarvis-http-api-token             # core — bearer for HTTP API on :4747
  jarvis-vapid                      # core — Web Push VAPID keypair
  telegram-bot-token                # MODULE: telegram-bot — BotFather token
  connector-<id>-<accountId>        # core — per-OAuth-account token blob
  connector-creds-<connectorId>     # core — user-provided client_id + secret
```

## Module-by-module breakdown

The declared `Module.memory` values render in Settings; this section
captures the same information offline + adds the "why" each store
exists.

### `calendar` — Calendar
Reads-only.

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/inbox/calendar.json` | file | read | Written by the `calendar-today-sync` workflow every 10 min. Module reads it for the agenda views + the calendar ambient-context provider. |

### `reminders` — Reminders

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/reminders.json` | file | read-write | Owned by `ReminderStore` in core. Persists across restarts; past-due fires re-arm on boot. |

### `quick-note` — Notes & Reminders

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/notes/<date>.md` | file | write | `/note` appends a timestamped entry to today's file. Markdown. |
| `~/.jarvis/notes/<project>/<date>.md` | file | write | Created when `/note` input starts with `<alias>:` — routes the entry under the matching project. |
| `config.json · moduleSettings.quick-note` | config | read-write | `dedupeCadence` + `dedupeSensitivity` (Settings → Modules). |

### `meeting-recorder` — Meeting recorder

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/meetings/<ts>-<slug>.md` | file | write | Markdown transcript + auto-debrief. One file per recorded meeting; never overwritten. |
| `~/.jarvis/meetings/<project-slug>/<ts>-<slug>.md` | file | write | When a project scope is set at `/meeting` time, the transcript files under that project instead. |

### `voice` — Voice

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/models/` | directory | read-write | ONNX-quantised whisper-base lazily downloaded by Transformers.js on first dictation. ~150 MB. Safe to delete; will re-download. |

### `telegram-bot` — Telegram bot

| Store | Kind | Access | Notes |
|---|---|---|---|
| `Keychain · telegram-bot-token` | keychain | read-write | BotFather HTTP API token. Service is `app.jarvis`. Never crosses IPC to the renderer. |
| `config.json · moduleSettings.telegram-bot` | config | read-write | Allowed chat IDs + "send as" toggle (bot vs user). Plaintext — no secrets. |
| In-memory chat ↔ taskId map | memory | read-write | Maps a Telegram chat to the most-recent Jarvis taskId so "reply to the bot" continues the same SDK session. Lost on restart. |

### `claude-code-watch` — Claude Code observer
Read-only on Anthropic-owned files.

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.claude/projects/<project>/<sessionId>.jsonl` | directory | read | Written by the Claude Code CLI. We only TAIL — never write. Polled every 1.5s. Files Jarvis owns (own session IDs) are filtered out so the same task doesn't appear twice. |
| In-memory session positions | memory | read-write | Per-file byte offset + last-event metadata so we resume reading where we left off. Reset on app restart (re-scan reconstructs). |

### `workflows` — Workflows

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/workflows/<id>.json` | directory | read | Chokidar-watched. Defs are seeded on first launch (calendar-sync, inbox-curate, linear/slack pollers, PR autopilot). The module just dispatches; the `WorkflowStore` owns the files. |
| `jarvis.sqlite · workflow_runs` | sqlite | read | Per-run timing + per-step inputs/outputs. Pruned hourly to 200 rows per workflow + 30 days. |

### `skill-suggester` — Skill suggester

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/skill-suggestions.json` | file | read-write | Accepted/dismissed/pending suggestions surfaced in the Inbox. |
| `~/.jarvis/.skill-batch.json` | file | read-write | Transient drop file where the skill-author skill writes its proposals. |
| `~/.jarvis/skills/<name>/SKILL.md` | directory | write | On "accept", the suggestion is committed as a real skill. |

### `work-awareness` — Work awareness
Discoverable wrapper around the ambient-watcher (skill + workflow +
calibration + inbox source) bundle. The module declares the four
storage locations so the user can find + reason about them in
Settings → Modules → Work awareness.

| Store | Kind | Access | Notes |
|---|---|---|---|
| `~/.jarvis/work-awareness-priorities.md` | file | read-write | Shapes the watcher's lens: people who matter, what to mute, what counts as "done" for auto-dismissal. Skill reads it on every tick. |
| `~/.jarvis/skills/work-awareness/SKILL.md` | file | read | haiku-4-5 by default. Bump the model in frontmatter for sharper synthesis. |
| `~/.jarvis/workflows/work-awareness-loop.json` | file | read | Cron: `*/30 {businessHours}`. Default disabled — toggle on in Settings → Workflows after editing priorities. |
| `~/.jarvis/inbox/work-awareness.json` | file | write | Output: `items[]` (surface) + `dismissals[]` (8h soft-snooze applied automatically by userInboxSource). |

### Modules with no own storage

These are intent-only or pure-RAM and don't declare `memory`:

- `send` — palette intents to push prompts to skills
- `shell` — output streams via TaskRunner → `task_events`
- `shell-nav` — palette intents that navigate the UI
- `status` — palette intents that read live runtime state
- `pr-workflows` — invokes the `gh` CLI; output is per-task

## Core storage (not owned by a module)

### Config

| Path | What | Owner |
|---|---|---|
| `~/.jarvis/config.json` | auth mode, AFK flag, paused flag, working hours, per-module preference blobs | `auth.ts` |
| `~/.jarvis/projects.json` | project list (name, aliases, repo, path, description) | `ProjectStore` |
| `~/.jarvis/projects/<slug>/memory/*.md` | per-project growing scratchpad (profile.md is the skill-written profile) | `ProjectMemoryStore` |
| `~/.jarvis/mcp.json` | global MCP server registry (skills opt in via frontmatter) | `McpConfigStore` |
| `~/.jarvis/integrations.json` | OAuth account metadata: id, provider, scopes, expiresAt. **NO TOKENS** — those live in Keychain. | `IntegrationsStore` |

### Feeds + curation

| Path | What | Owner |
|---|---|---|
| `~/.jarvis/inbox/*.json` | per-source feeds (pr, slack, linear, calendar, smart, reminders) | `InboxStore` + source workflows |
| `~/.jarvis/inbox-priorities.md` | calibration file for the smart-inbox curator (people / projects / topics / mutes) | user-editable; `/inbox-calibrate` writes |
| `~/.jarvis/intent-cache.json` | sha1 → classification cache for the awaiting-input classifier | `IntentClassifier` |

### Drafts

| Path | What | Owner |
|---|---|---|
| `jarvis.sqlite · ai_drafts` | one row per AI-generated draft awaiting review (Gmail / Slack DM / PR comment / PR review). Holds editable body + original body + context + channel-specific `sendAction` (mcp or shell). | `DraftsStore` |
| `~/.jarvis/triage-policy.md` | per-channel triage rules read by every triage skill (`gmail-triage`, `slack-dm-ack`, `pr-comments-triage`, `pr-review-triage`). People / archive rules / topics / tone / availability. | user-editable; `/triage-calibrate` writes |

### Scheduling

| Path | What | Owner |
|---|---|---|
| `~/.jarvis/skills/<name>/SKILL.md` | skill bodies + frontmatter (model, allowed-tools, mcp-servers) | `SkillStore`, chokidar-watched |
| `~/.jarvis/workflows/<id>.json` | XState-backed pipeline defs | `WorkflowStore`, chokidar-watched |
| `~/.jarvis/routines.json` | recurring crons of skill tasks | `RoutineStore` |

### Web Push

| Path | What | Owner |
|---|---|---|
| `~/.jarvis/push-subscriptions.json` | mobile PWA device subscriptions (keyed by opaque device id) | `electron/main/push.ts` |

### SQLite (`~/Library/Application Support/jarvis/jarvis.sqlite`)

Tables, all in WAL mode, foreign-keys on. Migrations are append-only in
[`electron/main/db.ts`](../electron/main/db.ts).

| Table | What |
|---|---|
| `tasks` | One row per task (id, status, prompt, skill, cost, timing, sdkSessionId, …) |
| `task_events` | Every SDKMessage the agent emitted — backfills the conversation view on remount |
| `activity_events` | Non-agent side-effects: meeting started, note archived, MCP disabled, autopilot decision, … |
| `workflow_runs` | Per-run history (steps + inputs/outputs + timing). Pruned hourly to 200/workflow + 30 days. |
| `ai_drafts` | One row per AI-generated draft (Gmail / Slack / PR reply, …) awaiting review. Holds the editable body, original body (for revert), context, and the channel-specific `sendAction` template (mcp or shell). Pruned hourly: sent/discarded older than 30 days drop; pending/sending/failed never auto-prune. |

### Keychain (service `app.jarvis`)

Every credential. Anything that could let someone act on your behalf
lives here, never in plaintext config.

| Account | What | Set from |
|---|---|---|
| `anthropic-api-key` | API mode credential | Setup screen / Settings → API |
| `claude-code-subscription-token` | Subscription mode oauth token from `claude setup-token` | Settings → Auth |
| `jarvis-http-api-token` | Bearer for the HTTP API on `:4747` (mobile PWA, Shortcuts, CLI) | Auto-generated on first launch |
| `jarvis-vapid` | Web Push VAPID keypair (single JSON blob) | Auto-generated on first push subscriber |
| `telegram-bot-token` | BotFather HTTP API token | Settings → Modules → Telegram bot |
| `connector-<id>-<accountId>` | Per-OAuth-account token blob (connector decides shape) | OAuth flow on Settings → Integrations |
| `connector-creds-<connectorId>` | User-provided client_id + (optional) client_secret per OAuth connector | Settings → Integrations → Advanced |

## What's NOT stored

- **No analytics, telemetry, or remote logging.** Anthropic API traffic
  goes Mac → Anthropic directly; nothing routes through us.
- **No cloud backup.** Time Machine / iCloud are your only persistence
  beyond the local files above. Worth backing up `~/.jarvis/` if you
  care about your skills + notes.
- **No multi-user state.** Everything assumes single user, single Mac.
- **No password storage.** SSO / OAuth only; we never see or persist a
  password (the user enters it in the browser during the OAuth flow).

## Migrations + housekeeping

- **SQLite migrations** are append-only in
  [`db.ts`](../electron/main/db.ts). Never edit a shipped migration —
  add a new one.
- **Workflow run history** is pruned hourly: 200 rows per workflow +
  30 days. Tunable in `pruneWorkflowRuns()`.
- **AI drafts** are pruned hourly: sent/discarded older than 30 days
  drop; pending/sending/failed never auto-prune (those need user
  attention). Tunable in `DraftsStore.prune()`.
- **Task runner** sweeps orphaned `status='running'` tasks every 5 min
  (30-min idle cutoff) so the UI doesn't show ghost live cards forever.
- **Subscription tokens** get refreshed automatically by the
  `tokenRefresher` — expired ones auto-renew without user intervention
  (Google), or the Integrations UI flags them for re-auth.
- **Whisper models** are lazily downloaded on first dictation; safe to
  `rm -rf ~/.jarvis/models/` if you want to reclaim ~150 MB.

## Adding new storage

If you're building a feature and need to persist something:

- **Secret (token, API key, password):** add a `get/set/clear` triple
  in [`electron/main/secrets.ts`](../electron/main/secrets.ts) with a
  fresh `ACCOUNT_<NAME>` constant. **Never** add secrets to
  `moduleSettings` — that's plaintext config.json.
- **User-tweakable preference:** declare a `settings` schema on your
  module. The renderer auto-draws the panel; values land in
  `config.json · moduleSettings.<id>`.
- **Long-lived data file:** put it under `~/.jarvis/<module-id>/` (or
  follow existing patterns: notes, meetings, models). Use
  `ctx.jarvisRoot` to build paths. Plan eviction up front for anything
  that grows.
- **Indexed structured data:** new SQLite table + migration in `db.ts`.
- **Declare in `Module.memory`** so it shows in Settings → Modules and
  here.

The Settings → Modules surface auto-renders whatever the module
declares — so declaring is the discovery mechanism for users and for
the next contributor reading the code.
