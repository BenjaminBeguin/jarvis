export default `---
name: linear-inbox
description: Pull Linear issues that need my attention (assigned, mentioned, blocked-on-me) and write them as inbox items
allowed-tools:
  - Read
  - Write
  - mcp__*
mcp-servers:
  - linear
---

You scan Linear for issues that **need the user's attention** and
write them as inbox items so they appear in the Jarvis Inbox tab. The
Inbox auto-refreshes every 5 min and picks up the file.

## What "needs attention" means

- **Issues assigned to me** in active states (Todo, In Progress, In
  Review) — not Done/Canceled.
- **Issues that mention me** with an unread / unresponded comment
  thread.
- **Issues with state changes I should know about** — moved into
  "Blocked", "Needs review from me", a state name varies per workspace.
- **Past-due** issues (dueDate < today) regardless of assignee, IF
  the user is on the team and the issue is in their cycle.

Skip:
- Issues I'm just a follower on with no recent activity.
- Issues in "Backlog" / "Triage" — those aren't actionable today.
- Auto-generated issues from integrations (where the title looks like
  a JSON dump or has bot-style prefixes).

## Output location

Write to exactly this path:

\`\`\`
~/.jarvis/inbox/linear.json
\`\`\`

As a wrapper:

\`\`\`json
{
  "source": "linear",
  "label": "Linear · needs you",
  "items": [ ... ]
}
\`\`\`

Overwrite on every run. Empty array is valid — clears the section.

## Per-item shape

\`\`\`json
{
  "id": "linear-<issue-id>",
  "title": "<identifier> · <title>",
  "subtitle": "<state> · <team> · <priority if Urgent/High>",
  "url": "<linear issue url>",
  "fireAt": <ms epoch — issue.dueDate if set, otherwise omit>,
  "createdAt": <ms epoch of last update>,
  "project": "<project-name-if-mapped>",
  "action": {
    "label": "Open in Linear",
    "skillId": "send",
    "prompt": "Open the Linear issue at <url> and propose the next move"
  }
}
\`\`\`

- \`id\` must be stable across runs — use the Linear issue id (not the
  identifier like "ENG-123"; the underlying GraphQL id). Re-runs
  don't trigger "new" notifications when ids match.
- \`fireAt\` only when there's a real due date. Time-pressured items
  float to the top of the Inbox.
- \`project\` only if the user has tracked projects whose \`name\` or
  \`aliases\` clearly match the Linear team / project. Skip if
  ambiguous — false matches cause the scope filter to lie.

## Process

1. Discover via \`mcp__linear__*\` tools. If Linear MCP isn't connected,
   write the empty wrapper and stop. Don't error.
2. Identify the current user via the Linear viewer query.
3. Fetch issues in batches (start with assigned + cycle). Cap at 40.
4. For each issue, decide if it "needs attention" per the rules above.
   Skip otherwise.
5. Emit items in priority order: past-due first, then in-review,
   then in-progress, then todo.

## Hard rules

- **Stable ids.** Re-emitting the same issue with the same id is fine;
  changing the id would re-notify and annoy.
- **Don't include sensitive content** in the title. Issue titles are
  fine; don't paste descriptions.
- **One-line confirmation** when done: "Linear: 7 issues need you
  (2 past due)" or "Linear inbox clean."

## Setting it up

The user wires this on a routine, same pattern as slack-inbox:

\`\`\`json
{
  "id": "linear-inbox",
  "skillId": "linear-inbox",
  "cron": "*/15 * * * *",
  "input": "Refresh Linear inbox.",
  "enabled": true
}
\`\`\`
`;
