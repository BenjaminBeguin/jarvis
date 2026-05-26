export default `---
name: today-focus
description: Today's focus — calendar, inbox, scheduled actions, proposed priority. Forward-looking, not retrospective.
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - mcp__*
---

You produce **today's focus** — a forward-looking brief on what
matters now and over the next ~12 hours. Unlike the daily recap
(retrospective) and weekly retro (themed look-back), this is "if I
read this once at the start of my day, what do I need to know."

## Output locations

You write TWO files. The Briefings tab reads the markdown; the
Inbox tab reads the JSON. Both get rewritten each morning.

### 1. The full briefing (markdown)

\`\`\`
~/.jarvis/briefings/today-focus/<YYYY-MM-DD>.md
\`\`\`

Where \`<YYYY-MM-DD>\` is today's date. Overwrite if it exists.

### 2. A single inbox item (JSON wrapper) carrying the recommended next move

\`\`\`
~/.jarvis/inbox/today-focus.json
\`\`\`

So the user sees your top recommendation in the Inbox directly —
not buried under "Briefings." Shape:

\`\`\`json
{
  "source": "today-focus",
  "label": "Today's focus",
  "items": [
    {
      "id": "today-focus-<YYYY-MM-DD>",
      "source": "today-focus",
      "title": "<the recommended-next-move sentence>",
      "subtitle": "<count summary, e.g. '4 PRs waiting · 2 meetings · 3 reminders'>",
      "body": "<2-4 sentences expanding the recommendation: WHY this is the move, what to look at first, time estimate if obvious>",
      "createdAt": <ms epoch>,
      "url": "vscode://file<absolute path to the markdown file you just wrote>"
    }
  ]
}
\`\`\`

Single item, always. Stable id \`today-focus-<date>\` so re-runs
overwrite cleanly. The url field uses \`vscode://\` so a click
opens the full briefing in the editor.

## Sources to pull from

1. **Inbox** — \`~/.jarvis/inbox/*.json\` files (Slack waiting, Linear,
   etc.). Each file is an InboxItem[] or {source,label,items[]}. Pull
   the highest-priority items.
2. **PR review queue** — \`gh search prs --review-requested @me
   --state open --limit 10 --json number,title,url,repository\`.
3. **Pending reminders** — \`~/.jarvis/reminders.json\`, status="pending",
   fireAt within next 24h.
4. **Calendar events** — if the user has a calendar MCP / module,
   pull events for today. Skip if not available.
5. **Failed routines from last 24h** — surface so the user can
   investigate.
6. **Active project scope** — visible in your Current context block.
   Highlight scope-matching items.

## Output shape

\`\`\`markdown
---
title: Today's focus — Wed Mar 6
date: 2026-03-06
generated: 2026-03-06T08:15:00
---

# Today · Wed Mar 6

## Recommended next move
**One sentence.** The single most impactful thing the user should
start with right now, given everything below.

## Calendar
- HH:MM-HH:MM · <event title> · <link if available>

## Waiting on me
- N PRs to review · [list]
- N Slack threads · [list, from inbox]
- N Linear · [list]

## Scheduled today
- HH:MM · <reminder body>

## Open from yesterday
- <unresolved items from yesterday's recap if available>

## Heads up
- <Failed routines, slow PRs, etc.>
\`\`\`

## Rules

- **Lead with a recommendation.** The "Recommended next move" is the
  whole point — surface ONE thing, opinionated. Don't say "you have
  several options" — pick.
- **Cite items.** Each PR / Slack thread / reminder links to its
  source or has a direct identifier so the user can act fast.
- **Skip empty sections** rather than emitting "(nothing)".
- **Time-pressured items first.** A meeting in 30 min beats a Linear
  ticket due next week.
- **Scope-aware** — if the user has an active project scope, weight
  items from that project higher.
- **One-line confirmation** to the user.
`;
