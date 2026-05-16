# Attention orchestration

The shift in how Jarvis frames itself: not "a place to run agents," but
"a place that knows what matters now and surfaces it." This doc captures
the model + state of play so future iterations don't drift from the
goal.

## The three time-axes

Every signal in Jarvis lives on one of three axes:

| Axis | What it answers | Surfaces |
|---|---|---|
| **Past** | What happened? | Activity feed, Tasks list (history) |
| **Present** | What needs me right now? | **Inbox** (queue + live strips), Observatory (live runs) |
| **Future** | What's coming? | Reminders, Routines, calendar items inside Inbox |

The product instinct that drove an earlier iteration: **present** had no
dedicated home. The first answer was a `Now` tab that synthesized
across reminders, time-pressured inbox items, and broken routines.
After shipping it and looking honestly at the overlap, 4 of 5 bands
were thin re-presentations of Inbox + Observatory data; only the
**meeting strip** was genuinely new. The Now tab was retired and its
two non-redundant bits (Meeting strip + Awaiting-reply strip)
collapsed into the Inbox header.

## The Inbox contract (post-collapse)

Inbox is now both the queue *and* the live-state surface. Layout:

  - **Header** — title + scope pill + filter chip + actions + ⚙
    settings popover.
  - **Live strips** (above the queue, toggleable via ⚙):
    - **Meeting strip** — `🎙 Record meeting` button + honest
      `auto-detect: live/quiet/fault` pill. The button works
      regardless of detection state.
    - **Awaiting reply strip** — tasks blocked on human input
      (amber pulse, click → Observatory + focus). Hidden when
      empty.
  - **Source-grouped queue** — Reminders / PR review / PR comments /
    Failed routines / Linear / Slack / etc. Sorted by urgency
    score (see `@shared/inbox-urgency`).

What the Inbox is **not**:
- It is not a curated dashboard — sources / strips are global, not
  per-user-pinned. The Dashboard tab still exists for curation.
- It is not the full Activity feed — Inbox is "what's waiting,"
  Activity is "what happened."

## Why the Now tab was retired

Honest accounting of what each band added:
  - Top of mind = Inbox top-N by urgency (Inbox already sorts that way)
  - Next 30 min = Inbox fireAt-soonest items (urgency floats them)
  - Broken today = the `failed-routines` Inbox source filtered to today
  - In progress = Observatory's running filter (kept the dedicated tab)
  - Meeting band = genuinely new — survived as the Inbox Meeting strip

The synthesis-on-one-screen story was real but the implementation
duplicated stores it could have surfaced via the Inbox + a tiny
header band. Collapsed in a follow-up commit; preferences for the
strips ride on the existing InboxPrefs IPC.

## Why entity links matter

A task today carries `origin: 'routine'` — fine for buckets, but
useless for queries like "show me runs of *this specific* routine."
That ambiguity meant features like per-routine cost dashboards and
exact streak detection were guess-by-skillId hacks.

The fix (this iteration): `tasks.routineId` / `reminderId` /
`projectName` columns. Now the entity graph is:

```
Routine ──fires──> Task ──may resume──> SDK session
Reminder ─fires──> Task                      │
Project ─scopes─> Task                       ▼
                                       Claude Code session on disk
```

And tasks know all four of their upstream entities. The migration is
additive (nullable columns, no historical backfill), so the change is
low-risk; UI surfaces can adopt the new links incrementally.

## What surfaces already use the model

Built so far:

- **Activity feed** — broad coverage of every user-side action
  (routine / skill / module / MCP / project / preferences / auth /
  inbox CRUD). Provides the audit answer.
- **Inbox** — aggregator over reminders, PRs (gh CLI), Linear (skill),
  failed routines, calendar, dedupe proposals. Auto-seeds inbox
  routines when MCPs are configured + no routine fires them.
- **Module Settings modal** — per-module history pane that filters the
  Activity feed via `moduleIdFromActivityKind`. Audit one module at a
  time.
- **Failed-routines streak detection** — groups by skillId (about to
  become exact via routineId), shows "N in a row" so silent failures
  surface as urgent.
- **Builder panel (Settings → Builder)** — interactive guide for
  adding skills / modules / routines / MCPs / inbox sources.
- **Now** — attention synthesis, new with this iteration.

## What shipped after the foundation

- **Inbox urgency scoring** — `urgencyScore()` in `inbox.ts` is now
  the single source of truth. Combines fireAt distance, source weight,
  and age. PR-review with stale comments outranks tomorrow night's
  calendar event; past-due reminders within 24h stay urgent. Source
  weights are exported so future surfaces re-rank consistently.
- **Meeting detection + macOS 15 fix.** The `coreaudiod` log channel
  is largely silent on Sequoia. Three changes: broader predicate +
  keyword heuristic for the rare events that do fire; a status
  surface (`MeetingDetectionStatus`) shown as the Inbox meeting
  strip pill (`auto-detect: live / quiet / fault`); a manual
  `🎙 Record meeting` button that bypasses detection entirely.
  Honest UX: when auto-detect is unreliable, the pill goes yellow
  and the button is one click.

## Still open

- **Skill-to-skill chaining + `parent_task_id`.** Scheduled for
  Phase 4 in the roadmap. Belongs in the entity graph but doesn't
  have an emit site yet — wait for the first chain.
- **Activity → entity FKs.** Today `activity_events` stashes
  `taskId` / `routineId` in `detail_json` ad-hoc. A first-class FK
  column unlocks indexed queries (e.g. "show me everything that
  happened in project X"). Defer until a use case beyond JSON-scan
  emerges. The Module Settings history pane filters in renderer
  today; if that gets slow at scale, that's the trigger.
- **Native helper for mic/camera detection.** The honest fix for
  the macOS 15 audio-log silence is a tiny Swift helper that
  listens to `kAudioDevicePropertyDeviceIsRunningSomewhere` +
  CMIO directly. Ships in the app bundle. Heavy enough to be its
  own iteration; the pill + button is the bridge.
- **Calendar-aware Now.** If the user is in a focus block per their
  calendar MCP, the imminent band could suppress non-critical
  reminders. Requires the calendar MCP to be reliably queried + a
  preference for "what counts as critical."
- **Context across sessions.** When a task resumes (`sdkSessionId`),
  the Now view could show "↪ continuing from yesterday." The title
  prefix already uses `↪ ` but the Now row doesn't flag it
  semantically yet.

## Decisions that shaped the surface

- **Default tab is Now, not Dashboard.** Dashboard is curation;
  attention is the more frequent need. Dashboard stays one click
  away (⌘2).
- **Origin stays a loose bucket; entity links are the precise
  signal.** When a scheduled reminder fires a task, `origin` stays
  `'palette'` (so notification policy treats it as user-initiated),
  but `reminderId` carries the real link. Don't conflate UX bucket
  with provenance.
- **20-second tick on Now.** Live without thrashing. Items cross
  the 30-min boundary organically, relative times stay accurate.
- **No auto-actions from Now.** Items click through to their
  canonical surface (Inbox / Observatory). Now is a viewing-layer,
  not a control plane — keep it cheap to glance at.
