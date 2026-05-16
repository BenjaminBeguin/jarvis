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
| **Present** | What needs me right now? | **Now** (new), Observatory (live runs) |
| **Future** | What's coming? | Inbox, Reminders, Routines, Today Focus |

The product gap that drove this iteration: **present** had no dedicated
home. Observatory was close — it shows running tasks — but it didn't
synthesize across reminders, time-pressured inbox items, and broken
routines. The `Now` tab fills that gap.

## The Now contract

`Now` is a synthesis surface, not a queue. It answers one question:
"if I look at one screen right now, what should I see?"

Three bands, ordered by demand on the user:

1. **In progress** — tasks awaiting your reply, then other running
   tasks. The agent loop is blocked on you here, so it goes first.
2. **Next 30 min** — reminders / inbox items with `fireAt` in the
   imminent window. Naturally rotates as time passes.
3. **Broken today** — routine-fired tasks that errored today.
   Hoisted out of the failed-routines inbox source so silent
   nightly failures don't sit unread for days.

What `Now` is **not**:
- It is not a curated dashboard. The user doesn't pin things to it;
  it pulls from existing stores.
- It is not a feed. Items leave when they're handled or expire.
- It is not the full inbox. It's a slice — the next 30 minutes.

The litmus test for whether something belongs on `Now`: would a user
glancing at it for 3 seconds learn something they didn't already
know? If yes, it belongs. If no (e.g. yesterday's completed tasks,
next week's calendar), it goes somewhere else.

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

## Open questions

These came up but didn't ship — list here so future iterations can
return to them:

- **Inbox urgency scoring.** Currently the inbox shows items in
  `fireAt` order. A real urgency layer would combine `fireAt`, source
  type (PR vs. calendar vs. reminder), dismissal history, and project
  scope into a rank. This benefits from user input on weighting.
- **Skill-to-skill chaining + `parent_task_id`.** Scheduled for
  Phase 4 in the roadmap. Belongs in the entity graph but doesn't
  have an emit site yet.
- **Activity → entity FKs.** Today `activity_events` stashes
  `taskId` / `routineId` in `detail_json` ad-hoc. A first-class FK
  column unlocks indexed queries (e.g. "show me everything that
  happened in project X"). Defer until a use case beyond JSON-scan
  emerges.
- **Calendar-aware Now.** If the user is in a focus block per their
  calendar MCP, the imminent band could suppress non-critical
  reminders. Requires the calendar MCP to be reliably queried + a
  preference for "what counts as critical."
- **Context across sessions.** When a task resumes (`sdkSessionId`),
  the Now view could show "↪ continuing from yesterday." Today it
  just shows the resumed task as a new row.

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
