# Send as user, not as bot (Slack)

## Why

The current Slack MCP setup uses a Bot User OAuth Token (`xoxb-…`).
Messages show in Slack as posted by the "Jarvis APP" bot, not by
you. For "quick message to Luca", looking like a bot is a real
friction — recipients treat bot messages differently, replies don't
land in your DMs, etc.

## What

Slack supports User OAuth Tokens (`xoxp-…`), tied to your actual
account. With those, `chat.postMessage` posts AS YOU. Same MCP tool
surface, different token type → different sender.

Add a toggle (or distinct catalog entry) for user-token mode. Users
who want "messages from me" can opt in; users who want bot mode
(clearer attribution) can stay.

## How (rough)

- Slack app setup: enable User Token Scopes alongside Bot Token
  Scopes. Same install flow, but the token returned changes.
- Bot scopes needed: `chat:write`, `users:read`, etc.
- User scopes needed: `chat:write` (different scope set entirely),
  `users:read`, `im:write`. Slack docs split these clearly.
- Catalog: a single Slack card with a "Token type" radio (bot / user)
  — different scope hints surface depending on selection. Saved
  config stores the right env var (`SLACK_BOT_TOKEN` vs
  `SLACK_USER_TOKEN`).
- The Slack MCP server we use (`@modelcontextprotocol/server-slack`)
  reads the bot token env. Check whether it also supports user
  tokens — if not, may need to swap to a different server (community
  ones exist that do both) or wrap with a small adapter.

## Tradeoffs / risks

- **User tokens are powerful**. They have your full account scope —
  if leaked, an attacker can act as you in Slack. Bot tokens are
  scoped narrower. Make the danger explicit in the UI.
- **Some Slack workspaces disable user tokens**. Workspace admins
  can block User Token Scopes. Detect this gracefully.

## Effort

~1 session if the existing MCP server supports user tokens; ~2 if
we need to swap or wrap.

## Related

- [Multi-workspace Slack](./multi-workspace-slack.md) — usually
  bundled.
