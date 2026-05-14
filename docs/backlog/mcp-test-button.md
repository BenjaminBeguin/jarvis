# MCP "test connection" button

## Why

Today the Integrations form saves the MCP entry, but doesn't verify it
actually spawns + handshakes. The user finds out their Slack token is
wrong only when `/send` says "no slack tools available" minutes later.
The MCP tool playground works as a manual verifier but requires opening
"Show tools" → waiting for spawn → looking for ✓.

A dedicated "Test connection" button on the form gives the user
confidence at save time.

## What

A `Test` button next to `Save` in each catalog form (and Custom MCP).
Click → spawns the server with the freshly-typed env / args (without
persisting), runs the JSON-RPC handshake just up through `initialize`,
shows a green ✓ or a red ✗ with the actual error.

If the test passes, the Save button enables. If it fails, the error
inlines and the user can fix without saving.

## How (rough)

- New IPC `testMcpServer(input: McpServerInput)` that takes the same
  shape as `addMcpServer` but doesn't persist.
- Reuses `mcp-probe.ts` logic but stops after `initialize` (we don't
  need the full tools list for a connectivity check). 5s timeout.
- Returns `{ ok, serverInfo?, message? }` — serverInfo is the
  `initialize` response payload (name, version) so we can show
  "Connected to slack-mcp v1.4.2".
- Form-side: a `testing | tested-ok | tested-fail | dirty` state per
  field interaction; dirty edits reset to untested.

## Tradeoffs / risks

- **Test on save = mandatory friction**. Don't make it block save; some
  servers (Linear MCP on cold start) are slow, user should be able to
  save and trust they got the token right.
- **State of the form vs disk**. The test should use the form values,
  NOT what's on disk. Careful not to read from `McpConfigStore.get(id)`
  by accident.

## Effort

~1 session. Small.

## Related

- Already-shipped MCP probe + playground use the same handshake.
