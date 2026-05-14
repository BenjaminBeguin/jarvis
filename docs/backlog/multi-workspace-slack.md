# Multi-workspace Slack

## Why

The Slack MCP catalog entry assumes one workspace per Jarvis install.
Real users often have 2-3: personal community Slack, work Slack, a
client's Slack. Currently they'd have to swap the token in mcp.json to
switch which workspace `/send` targets — terrible.

## What

A pattern parallel to Gmail's `gmail-personal` / `gmail-work` split:

```
mcp.json:
  slack-personal: { ...xoxb-personal token... }
  slack-work:     { ...xoxb-work token... }
  slack-client:   { ...xoxb-client token... }
```

Catalog grows entries for `Slack · personal`, `Slack · work`. The
`send` skill picks the right workspace from natural language ("send
Luca on personal slack: …") or asks if ambiguous.

## How (rough)

- Refactor the Slack catalog entry to take a `:suffix` parameter
  like Gmail does. Each card writes a distinct mcp.json entry
  (`slack-personal`, `slack-work`, etc.) with its own token + team id.
- The `send` skill already gets all `mcp__*` tools — the
  `mcp__slack-personal__send_message` vs
  `mcp__slack-work__send_message` distinction is already visible to
  Claude. Just need to make the skill prompt recognize the
  account-disambiguation in the user's request.
- Catalog UI: a "+ Add another Slack workspace" affordance next to
  the Slack card. Opens a fresh form with `suffix` field
  (`-personal`, `-work`, etc.).

## Tradeoffs / risks

- **Bot vs user tokens**. Different workspaces may have different bot
  installs with different scope sets. Each entry's scope list is
  whatever the user picked at install time; the skill has to handle
  some workspaces having `chat:write` only, others having
  `files:write` too.
- **Workspace name parsing in NL**. "send Luca on personal" implies
  the workspace alias. The skill prompt needs to teach Claude the
  aliases the user has configured.

## Effort

~2 sessions. The mcp-side is small; the skill-side prompt work is the
real chunk.

## Related

- Gmail already does this pattern (see catalog).
- [Send as user, not bot](./send-as-user.md) — orthogonal but
  frequently bundled with multi-workspace.
