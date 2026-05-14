# Daemon split

## Why

Everything good Jarvis does (scheduled actions, reminders, daily routines,
meeting debriefs) currently dies the moment you close your laptop. The
3pm "ping Luca if no review" action doesn't fire. The morning brief never
runs while you sleep. Today's architecture is "everything happens on this
machine while it's awake."

## What

Extract the main process from Electron into a headless Node daemon you
can run anywhere always-on — Mac mini at home, $5/mo VPS, even a NAS.
Reminders fire there, MCPs spawn there, the agent loop runs there. The
Electron app becomes a thin client that connects to the daemon over
WebSocket / HTTP. From your laptop, your phone (PWA), wherever.

The code shape is already 80% there: main owns all state, renderer is a
pure view. The remaining 20% is making main not depend on Electron-only
APIs.

## How (rough)

- Identify Electron-only deps in main: `BrowserWindow`, `Notification`,
  `globalShortcut`, `Tray`, `shell.openExternal`, mic permission probe.
  Most are window/system bindings; isolate them behind a
  `PlatformAdapter` interface with `electron` + `headless` impls.
- Replace ipcMain with a small HTTP / WebSocket server bound to
  localhost (later: TLS for remote use). One channel per existing IPC.
- Renderer connects via `fetch` + `ws://` instead of `ipcRenderer`.
  Same `subscribe`/`invoke` shape behind the scenes.
- Auth: per-machine secret in `~/.jarvis/daemon.token`, shared in HTTP
  headers. For remote: Tailscale + still that token.
- Deployment: build a single Node binary via `pkg` or `bun build
  --compile`, ship as a systemd / launchd service.
- Native notifications + tray live on the **client** side (the laptop
  app), not the daemon. Daemon emits "notify" events; the client
  surfaces them.
- Reminders + cron stay on the daemon — that's the whole point.
- Voice mic capture, iMessage MCP, filesystem MCP: still need the
  laptop. The daemon hosts what it can; client handles what's local.

## Tradeoffs / risks

- **Auth complexity**. Today's subscription auth is the local `claude`
  CLI token. On a server we'd need a copy of that token + auto-refresh,
  or switch to API-key mode for the server, or two-token mode (daemon
  uses API key, client uses subscription).
- **Filesystem context**. Skills like `ticket-to-pr` `cd` into your repo
  on your laptop. If the daemon runs on a Mac mini, it'd need access to
  those repos too (NFS? remote git? skip those skills?).
- **Refactor scope** — ~1 week of focused work; not weekend-shaped.
- **Worth it only when the pain shows up.** We're not there yet — most
  current usage assumes the laptop is open.

## Effort

~1 week. Trigger: the first time you miss a 3pm scheduled action because
the laptop was closed.

## Related

- [CLI](./cli.md) — the daemon split makes the CLI trivial (same protocol).
