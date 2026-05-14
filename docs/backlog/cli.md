# CLI · `brew install jarvis`

## Why

`/sh` and `>` palette intents cover most "run shell from Jarvis" cases.
The reverse — "fire a Jarvis command from my terminal" — is still
missing. Use cases:

- `jarvis send "luca on slack: 5 min late"` from inside `cd ~/Code/foo`.
- `jarvis remind in 2h "ship the patch"` while compiling.
- `jarvis note "TODO: refactor X"` instead of alt-tabbing.

**Currently deferred** — the user explicitly didn't want to build this
yet (we already have `/sh` and `>`, which is the bigger gap). Keep
this here for if/when the friction shows up.

## What

A `jarvis` binary on `$PATH`. Talks to the running Jarvis main
process over a Unix socket. Mirrors the palette's verbal-trigger
surface so the CLI command line is naturally identical to what the
user would say.

```sh
jarvis send …            # fires the send intent
jarvis remind in 2h …    # reminder
jarvis note "…"          # note
jarvis status            # quick digest
jarvis sh "git status"   # shell task in HUD (rare; just run it directly)
jarvis open              # pop the palette
jarvis tasks             # list running tasks
jarvis stop <id>         # abort
```

## How (rough)

- Main process: bind a Unix socket at `~/.jarvis/socket`. JSON-RPC-ish
  request/response, plus an optional stream channel for outputs.
- Auth: a per-machine secret at `~/.jarvis/socket.token`, file
  permissions 0600. CLI reads it on each invoke. Docker-style.
- CLI: a small Node script (or `bun build --compile` for a single
  binary). Connects, sends `{op, args}`, prints the result.
- Packaging:
  - Phase 1 — `pnpm cli:link` symlinks `bin/jarvis` into
    `/usr/local/bin`. Try it locally.
  - Phase 2 — publish `jarvis-cli` on npm; `npm install -g jarvis-cli`.
  - Phase 3 — Homebrew tap: `brew tap yourorg/jarvis && brew install jarvis`.
- Operations map directly to existing IPC channels: `routePrompt`,
  `launchShell`, `listTasks`, `abortTask`, etc. Smallest possible CLI.

## Tradeoffs / risks

- **Daemon split first?** If we're going to do
  [daemon-split.md](./daemon-split.md), the CLI is trivial on top of
  that (same HTTP/WS endpoints). Doing the Unix-socket version now is
  cheap insurance but ~50% of the work is throwaway. Pick one path.
- **Token security**. Anyone with read access to your user dir gets
  full Jarvis control. Same threat model as `~/.docker/`, so fine.

## Effort

~1 session for Phase 1 (link locally). Brew tap is more polish than
code.

## Related

- [Daemon split](./daemon-split.md) — natural superset of this work.
