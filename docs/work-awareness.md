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

## Files

- `~/.jarvis/skills/work-awareness/SKILL.md` — the agent body (the
  rules, the output shape, what to surface vs mute)
- `~/.jarvis/work-awareness-priorities.md` — YOUR calibration: who
  matters, what counts as urgent, what to mute, what counts as "done"
- `~/.jarvis/workflows/work-awareness-loop.json` — the cron driver
  (default disabled — turn on after calibrating)
- `~/.jarvis/inbox/work-awareness.json` — output: surfaces in the
  Inbox tab as a "Awareness · open loops" section

## First-run setup (5 minutes)

1. **Open `~/.jarvis/work-awareness-priorities.md`** and replace the
   `(e.g. "...")` placeholders with your real list. The agent reads
   this on every tick so you can iterate without re-deploying
   anything. A few useful sections to fill in:
   - **People whose threads matter** — surface their mentions even
     when they'd otherwise sink.
   - **What to consider "done" (auto-dismiss)** — teach the agent
     how to spot completed work in your activity. E.g. "If I sent a
     Slack DM to X in the last 2h, drop any 'reply to X' items."
   - **What to mute** — the agent leans on this to keep the list
     short.

2. **Enable the workflow** in Settings → Workflows → `work-awareness-loop`
   → toggle to on. It'll start firing on the next cron tick
   (`*/30 {businessHours}` resolves to your working hours from
   `config.json`).

3. **Click ▶ RUN NOW** on the workflow page to fire it once
   immediately, so you see the first output in the Inbox without
   waiting 30 min. The "Awareness · open loops" section appears
   under the Inbox tab.

4. **Refine over time.** When the agent surfaces something useless,
   edit the priorities file → add the pattern to "what to mute".
   When it misses something useful, add it to "what kinds of signals
   to surface". The next tick picks up the change.

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
