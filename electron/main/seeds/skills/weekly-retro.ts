export default `---
name: weekly-retro
description: Last-7-days retro — what shipped, what blocked, what's still open. Themed not chronological.
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - mcp__*
---

You produce a **weekly retro** for the user — last 7 days, themed
rather than day-by-day. The point isn't "what happened Monday vs
Tuesday"; it's **patterns** — what shipped, what blocked you, what's
still open.

## Output location

Write the final markdown to exactly this path:

\`\`\`
~/.jarvis/briefings/weekly-retro/<YYYY-MM-DD>.md
\`\`\`

Where \`<YYYY-MM-DD>\` is **today's date** (the start of the new week
is when you're generating the retro for the prior 7 days).

If the file already exists, overwrite it.

## Sources to pull from

For the last 7 days:

1. **Meetings** — \`~/.jarvis/meetings/*.md\` from the last 7 days.
   Cluster by topic, not by date.
2. **PRs** — \`gh search prs --author @me --merged-at "$(date -v-7d
   +%Y-%m-%d)..$(date +%Y-%m-%d)"\` for merged; similar for created.
3. **Linear** — issues you moved status on; flag any that have been
   "in progress" > 5 days as stalled.
4. **Notes** — every note file from the last 7 days, looking for
   recurring themes / open questions / decisions.
5. **Completed routines / scheduled actions** — surface if they
   revealed something interesting.

## Output shape

\`\`\`markdown
---
title: Weekly retro — week of Mar 4
date: 2026-03-11
generated: 2026-03-11T09:00:00
window_start: 2026-03-04
window_end: 2026-03-11
---

# Weekly retro · week of Mar 4

## Themes
- **<theme>** — one paragraph weaving meetings + PRs + notes. Cite
  inline: "shipped [#3421](<url>) after Tuesday's review meeting
  ([transcript](<path>))".

## Shipped (N items)
- Bulleted list of merged PRs with one-line summary. Group by repo
  if more than one.

## Blocked or stalled
- Open Linear issues that have been "in progress" 5+ days.
- PRs awaiting review > 3 days.
- Threads from meetings that produced no follow-up.

## Open questions
- Things mentioned in notes that don't have a clear next action.

## Recurring patterns
- Things you noticed yourself doing repeatedly — candidates for new
  skills / routines.
\`\`\`

## Rules

- **Themes > timeline.** A retro is most useful when it surfaces
  patterns. Don't just list "Monday X, Tuesday Y".
- **Cite specifically.** Every theme paragraph links to the underlying
  meeting transcripts / PR / note.
- **Be honest about blocked.** If something stalled, say so. Don't
  euphemise.
- **Skip empty sections.** No filler.
- **One-line confirmation** to the user when done.
`;
