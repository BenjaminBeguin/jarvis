# Inbox scenarios

The Inbox tab aggregates "things waiting on you" from multiple sources.
Built-ins (reminders, PR review queue, your open PRs, failed routines)
ship out of the box. **You can add as many of your own as you want by
combining a skill + a routine.**

## How it works

The `user` inbox source reads every `*.json` file under
`~/.jarvis/inbox/` and surfaces its items. Each file is one source —
file name (sans `.json`) is the section header by default.

Any skill that writes to that directory becomes an inbox source. A
routine fires the skill on a schedule. The Inbox refreshes every 5
minutes and picks up changes automatically.

## File format

`~/.jarvis/inbox/<name>.json` is either:

**(A) Bare array** — quickest:

```json
[
  {
    "id": "stable-id-per-item",
    "title": "What's waiting on you",
    "subtitle": "optional context",
    "createdAt": 1715700000000,
    "url": "https://...",
    "action": {
      "label": "Address comments",
      "skillId": "pr-address-comments",
      "prompt": "Address PR https://..."
    }
  }
]
```

**(B) Wrapper** — preferred, controls section header:

```json
{
  "source": "slack",
  "label": "Slack waiting on you",
  "items": [ ... ]
}
```

### Field reference

| Field | Required | What it does |
|---|---|---|
| `id` | yes | Stable across runs. Re-appearing ids don't trigger "new" notifications. |
| `title` | yes | One-line primary text. |
| `subtitle` | no | Secondary line: repo · author · age · etc. |
| `createdAt` | yes | ms epoch. Falls back to file mtime if missing. |
| `fireAt` | no | For time-pressured items (reminders). Items with fireAt float to the top, soonest first. |
| `url` | no | Click "Open" → opens in browser. |
| `action.label` | no | Button text on the row. |
| `action.skillId` | no | Skill to launch when clicked. |
| `action.prompt` | when action set | Prompt to send to the skill. |
| `project` | no | Project alias for grouping/filtering. |

## Built-in: `slack-inbox` skill

Out of the box. Uses the Slack MCP to find DMs + mentions waiting on
you, writes `~/.jarvis/inbox/slack.json`. Set it up:

1. **Wire Slack MCP** — Settings → Integrations → install Slack (or
   add to `~/.jarvis/mcp.json` directly).
2. **Add a routine** to run it on a schedule. Edit
   `~/.jarvis/routines.json`:

   ```json
   [
     {
       "id": "slack-inbox",
       "skillId": "slack-inbox",
       "cron": "*/10 * * * *",
       "input": "Refresh Slack inbox.",
       "enabled": true
     }
   ]
   ```

3. **Wait 5 min** — the Inbox auto-refresh picks up the JSON.

## Authoring your own scenario

The pattern, in 3 steps:

1. **Write a skill** under `~/.jarvis/skills/<name>/SKILL.md`. Have
   it produce `InboxItem[]` JSON and Write it to
   `~/.jarvis/inbox/<source>.json`.
2. **Add a routine** with that skill on a cron schedule.
3. **Items appear in the Inbox.**

The Inbox does dedup by `id`, so re-runs with the same items don't
cause notification spam — only genuinely new ids ping.

## Example scenarios worth building

- **Linear inbox** — issues assigned to you, sorted by priority + due date
- **Calendar today** — events in the next 4 hours
- **GitHub Actions failures** — workflow runs that failed on your branches
- **Pages-with-stale-feedback** — Notion / docs you commented on > 7 days ago
- **Sentry issues** — new high-severity errors

Each is a SKILL.md + a routine entry.

## Briefings

Inbox items are bite-sized things to act on. A **briefing** is the
opposite: a structured digest with citations, generated periodically.
Example: "yesterday I worked on X, Y, Z (sources: 3 meetings, 5 PRs,
12 Slack threads); today's focus is A, B."

Briefings are routines under the hood — a skill that writes a
markdown digest and the routine that fires it. Output renders inline
in the **Routines** tab (per-routine history pane) and on the
**Dashboard** for routines pinned to the home screen. Built-ins
include `today-focus`, `daily-recap`, and `weekly-retro` — see
`electron/main/seeds/skills/` for the prompts.
