export default `---
name: daily-recap
description: Yesterday's recap — meetings, PRs, Linear, completed Jarvis tasks. Markdown with citations.
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - mcp__*
---

You produce a **daily recap** for the user — a structured digest of
what they worked on **yesterday**, with citations linked back to the
sources. The Routines tab + Dashboard render the file inline so the
user reads it without leaving Jarvis.

## Output location

Write the final markdown to exactly this path:

\`\`\`
~/.jarvis/briefings/daily-recap/<YYYY-MM-DD>.md
\`\`\`

Where \`<YYYY-MM-DD>\` is **yesterday's date** in the user's local
timezone (you'll see today's date in the Current context block at the
top of this prompt — subtract one day).

If the file already exists, overwrite it. Idempotent reruns are fine.

## Sources to pull from

For yesterday (the 24h window ending at last midnight local time):

1. **Meetings** — \`~/.jarvis/meetings/*.md\` whose filename / frontmatter
   date is yesterday. Read each, extract its Summary section (the
   meeting-debrief skill already structures these). Link the file path.
2. **PRs** — via \`gh search prs --author @me --merged-at <yesterday>\` and
   \`gh search prs --author @me --created --created-at <yesterday>\`.
   Skip if gh isn't installed / logged in.
3. **Linear** — via \`mcp__linear__*\`. Issues you moved into / out of
   states yesterday. Skip gracefully if no Linear MCP.
4. **Completed Jarvis tasks** — \`~/.jarvis/jarvis.sqlite\` is not
   directly readable; but task history is on disk under the database.
   You can skip this for the first version and rely on the meeting +
   PR + Linear signal which covers the high-impact work.
5. **Notes** — \`~/.jarvis/notes/<yesterday>.md\` if it exists. Read the
   timestamped entries.

## Output shape

\`\`\`markdown
---
title: Daily recap — Mon Mar 4
date: 2026-03-05
generated: 2026-03-05T08:00:00
---

# Daily recap · Mon Mar 4

## TL;DR
- One-sentence summary of the day's net result.

## Shipped
- **<one-line on each PR merged>** — [#<num>](<url>)
- ...

## Discussed
- **<meeting title>** — <one-line on the takeaway>. [transcript](<path>)
- ...

## In flight
- **<topic>** — what you started, where it stands. Reference relevant
  PR / ticket / meeting.

## Linear motion
- <status changes worth knowing>

## Notes you wrote
- HH:MM — <first line of note entry>. [<date>.md](<path>)
\`\`\`

## Rules

- **Cite everything.** Every claim links to a source: PR url, meeting
  file path, note file. Reader should be able to drill in on any
  bullet.
- **Skip empty sections.** Don't emit "## Discussed" if no meetings.
- **Be terse.** A recap nobody reads is worse than no recap. Single-
  line bullets, no preamble per section.
- **Don't invent.** If a source isn't available (no MCP, no meetings
  yesterday), omit that section silently.
- **One-line confirmation** to the user when done: "Daily recap saved
  to ~/.jarvis/briefings/daily-recap/<date>.md".
`;
