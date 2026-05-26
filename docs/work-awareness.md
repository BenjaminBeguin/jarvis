# Work awareness — Jarvis pays attention so you don't have to

The work-awareness loop is Jarvis's ambient watcher. Every 30 minutes
during your working hours, it scans everything you touched recently
across your connected surfaces and surfaces a tight "**your
attention**" list:

- Open questions in yesterday's meeting transcript with no follow-up
- A PR comment thread you replied to 3 days ago and never closed
- A Slack mention from a priority person you didn't get back to
- A Linear ticket assigned to you that just got new activity
- A meeting action item still un-done where the deadline is today

It also **proposes dismissals** — if you sent the Q3 update to Theo
this morning, the "send Theo the Q3 update" action item drops off.

The agent does the synthesis. You shape its lens via a markdown
file. No JS-based extractors — everything is a skill prompt.

## Module

This is the `work-awareness` module. Find it at **Settings → Modules
→ Work awareness** for the settings panel + the declared memory
map.

The structured config lives in the settings UI (config.json under
the hood). The companion priorities markdown is an optional
freeform supplement for nuance the settings can't capture (your
notion of "urgent", edge-case rules, running notes).

### Settings (the primary config surface)

| Field | What it does |
|---|---|
| **Priority people** | Comma-separated handles whose threads always count. ALWAYS surfaced; auto-detection adds more on top when enabled. |
| **Priority channels** | Slack channels (and similar) whose mentions always count. |
| **Mute channels / patterns** | Dropped entirely. Default: `#random, #announcements, #memes`. |
| **Auto-detect people from activity** | When ON, the agent also considers people who tagged you / reviewed your PRs in the past 2 weeks. Default ON. |
| **Auto-dismiss** | When ON, the agent drops inbox items where it can see you completed the action. Default ON. |
| **Dismissal confidence** | conservative / balanced / aggressive — gates how willing the agent is to dismiss. Default balanced. |
| **Max items per tick** | Cap on items[] in the output. Default 8. |

### Palette intents

- `/work-awareness` — fire the loop now (don't wait 30 min).
  Verbal triggers: "what should I look at", "check open loops",
  "what am I forgetting", "what is waiting on me".
- `/work-awareness-edit` — open the freeform priorities markdown
  in your default editor.
- `/work-awareness-calibrate` — scan recent activity across
  connected MCPs (Slack, GitHub, Linear, Notion) and propose
  concrete people / channels / mutes you can paste into the
  settings. Conversational — doesn't write to disk, you copy what
  you want.

## Files

- **Primary config**: `config.json · moduleSettings.work-awareness`
  (edit via Settings → Modules → Work awareness).
- `~/.jarvis/work-awareness-priorities.md` — freeform supplement
  for nuance the structured settings can't capture.
- `~/.jarvis/skills/work-awareness/SKILL.md` — the agent body
  (reads config.json + priorities md on every tick).
- `~/.jarvis/skills/work-awareness-calibrate/SKILL.md` — one-shot
  helper that proposes initial settings from activity.
- `~/.jarvis/workflows/work-awareness-loop.json` — cron driver
  (default disabled — toggle on after calibrating).
- `~/.jarvis/inbox/work-awareness.json` — output: surfaces in the
  Inbox tab as an "Awareness · open loops" section.

## First-run setup (2 minutes — no markdown editing required)

1. **Optionally hit `/work-awareness-calibrate`** in the palette.
   The agent scans your connected Slack / GitHub / Linear / Notion
   and prints a copy-pasteable list of proposed people, channels,
   and mutes based on real activity counts (not guesses). Skip this
   step if you'd rather configure manually.

2. **Settings → Modules → Work awareness.** Fill in the fields —
   the calibrate output is structured exactly to copy in. The agent
   reads these on every tick, no file editing needed.

3. **Enable the workflow** in Settings → Workflows →
   `work-awareness-loop` → toggle on. Default cron is
   `*/30 {businessHours}` (resolved from your config.json working
   hours).

4. **Hit `/work-awareness`** in the palette to fire it once
   immediately, so you see the first output in the Inbox without
   waiting 30 min. The "Awareness · open loops" section appears.

5. **Iterate.** Surface something useless? Add a pattern to
   **Mute channels / patterns**. Missing something? Add the person
   / channel to the priority lists. Re-fire `/work-awareness` to
   see the change immediately.

## What it reads (data flow)

| Source | How |
|---|---|
| `~/.jarvis/inbox/*.json` | Globbed via the agent's Read tool. Used to AVOID duplicates — if PR #421 is already in `pr-review.json`, the awareness pass won't re-surface it. |
| `~/.jarvis/meetings/**/*.md` | Last 3 days. Looks for open questions in transcripts + `## Action items` sections still un-done. |
| `~/.jarvis/notes/**/*.md` | Last 3 days. Looks for question lines + `TODO:` / `FOLLOWUP:` markers. |
| `~/.jarvis/reminders.json` | Via the Jarvis MCP — pending reminders firing in the next 24h. |
| activity feed | Via the Jarvis MCP — what you've DONE recently (PR merges, sends, etc.). Drives auto-dismissal. |
| Slack | If `mcp__slack__*` is connected — your unread mentions + threads where the ball is back in your court. |
| GitHub | Via `gh` CLI or `mcp__github__*` — PRs with new comments since your last push, issues with recent activity. |
| Linear | If `mcp__linear__*` is connected — assigned tickets with recent activity. |
| Notion | If `mcp__notion__*` is connected — pages you opened/edited in the last 24h with open comments tagged to you. |

The agent gracefully degrades when an MCP isn't connected — it just
mutes that source and moves on.

## How auto-dismissal works (today)

The skill's output JSON has both `items` (new open loops to surface)
AND a `dismissals` array — inbox item ids the agent inferred are
done based on recent activity. Example:

```json
{
  "source": "work-awareness",
  "label": "Awareness · open loops",
  "items": [ ... ],
  "dismissals": [
    "meeting-action-2026-05-26T14-30-eng-standup:2",
    "pr-review-https://github.com/foo/bar/pull/421"
  ]
}
```

**How it's wired:** `userInboxSource` (the JSON-file reader in
`electron/main/inbox-sources/user.ts`) consumes the `dismissals`
array on every fetch and forwards each id to
`InboxDismissalStore.dismiss(id, 8h)`. Items disappear from the
unified Inbox on the next refresh, no click required.

**Why 8h, not forever:** if the agent gets a dismissal wrong (says
"send Theo Q3" is done when actually you only DRAFTED a reply, didn't
send it), an 8-hour snooze means the item reappears in your next
working block and you have a chance to address it. "Forever"
dismissals stay tied to the user's manual ✕ button — the agent
isn't trusted with hard delete.

**De-duping across refreshes:** the source maintains an in-memory
set of `<filename>:<id>` keys it's already passed to the dismissal
store this process lifetime, so a workflow that re-writes the same
dismissal list on every tick doesn't re-fire the IPC. App restart
clears the set; the dismissal store on disk persists.

## Why a skill (not JS)

The "what counts as an open loop" question is semantic. A regex can't
tell that "I'll loop back on this" left a thread open while "we'll
ship it Friday" closed one. The agent can.

Same logic for dismissals — "send the Q3 update to Theo" maps to a
Slack DM to Theo with "Q3" in the body, even though the strings don't
match. The agent does the soft matching.

Cost is bounded: haiku-4-5 (`model:` in the skill's frontmatter),
every 30 min during business hours only. ~16 ticks/day × ~$0.005 =
under 10¢/day at typical input sizes. Edit the frontmatter to
`claude-sonnet-4-5` if you want sharper synthesis at higher cost.

## Architecture

```
       ┌────────────────────────────────────────────────────┐
       │ ~/.jarvis/work-awareness-priorities.md             │
       │  (your calibration)                                │
       └──────────────────────┬─────────────────────────────┘
                              │
                              ▼
       ┌────────────────────────────────────────────────────┐
       │ work-awareness-loop.json  (cron */30 businessHours)│
       │  pipeline: [ run-skill work-awareness ]            │
       └──────────────────────┬─────────────────────────────┘
                              │
                              ▼
       ┌────────────────────────────────────────────────────┐
       │ work-awareness skill (haiku-4-5)                   │
       │   reads inbox/*, meetings/*, notes/*, reminders,   │
       │     activity feed, Slack/GH/Linear/Notion MCPs     │
       │   writes ~/.jarvis/inbox/work-awareness.json       │
       └──────────────────────┬─────────────────────────────┘
                              │
                              ▼
       ┌────────────────────────────────────────────────────┐
       │ InboxStore picks up the file (userInboxSource)     │
       │  → "Awareness · open loops" section in Inbox tab   │
       │  → smart-curate's haiku also sees it + can rank    │
       │    it into the Smart section                       │
       └────────────────────────────────────────────────────┘
```

The same pattern used by `inbox-curate`, `tech-watch`, and the
gmail-triage flow — skill body holds the intelligence, workflow
holds the schedule, JSON file is the wire format. No new
infrastructure.

## Limits + next steps

- **No proactive note creation yet.** The user's original ask
  included "create notes dynamically" — that's a different skill
  (write to `~/.jarvis/notes/` when the awareness pass detects
  something worth capturing) and lands separately.
- **30-min cadence.** Tighter loops (`*/15`, `*/10`) cost
  proportionally more. Edit the workflow's cron if you want
  faster signal at higher token spend.
- **Confidence vs noise.** Early iterations will probably surface
  some items you don't care about. Don't pause the loop — instead,
  add a "what to mute" bullet for the noisy class. The skill picks
  it up on the next tick. Five iterations of the priorities file
  is usually enough to dial it in.
- **Recovering a wrongly-dismissed item.** The 8-hour soft snooze
  means it naturally reappears later, but if you want it back now,
  delete the matching entry from `~/.jarvis/inbox/.dismissed.json`
  and refresh the Inbox.
