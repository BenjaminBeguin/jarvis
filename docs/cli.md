# `jarvis` CLI

A small terminal client that drives the same Jarvis runtime as the
desktop app, via the localhost HTTP API (P5). Single-file Node script,
no npm install.

## Install

The script lives at [cli/jarvis](../cli/jarvis). Symlink anywhere on
your PATH:

```sh
ln -s "$(pwd)/cli/jarvis" /usr/local/bin/jarvis
# or, if /usr/local/bin needs sudo:
ln -s "$(pwd)/cli/jarvis" ~/bin/jarvis  # if ~/bin is on your PATH
```

Then check:

```sh
jarvis status
# ✓ jarvis v0.0.1
```

## How auth works

Zero config. The script reads the API bearer token from macOS Keychain
(account `jarvis-http-api-token`, service `app.jarvis`) via the
built-in `security` command. The token is seeded by the Jarvis app on
first launch, so as long as the app has run on this machine once, the
CLI works.

Server URL is hardcoded to `http://127.0.0.1:4747` — same as
Settings → API shows.

## Commands

### `jarvis status`

Health check + version.

### `jarvis run "<prompt>" [--skill X] [--attach]`

Launch a task with a free-text prompt. Returns the task id immediately.

```sh
jarvis run "summarise the diff at HEAD"
jarvis run "draft a slack reply to luca" --skill send
jarvis run "review PR https://github.com/foo/bar/pull/42" --skill pr-review-queue --attach
```

`--attach` tails the event stream until the task completes.

### `jarvis intent "<prompt>"`

Route through the palette intent parser. Handles reminders, scheduled
actions, and verbal-triggered intents.

```sh
jarvis intent "remind me in 5min to drink water"
# reminder set · 2026-05-14 18:30 · drink water

jarvis intent "create a hivecore project"
# (opens the new-project dialog in the running app)
```

### `jarvis tasks`

Last 20 tasks, one per line. Shows id, status, origin, title.

### `jarvis inbox`

Inbox items grouped by source. Same data the Inbox tab shows.

### `jarvis attach <task-id>`

Tail a running task's event stream. Polls every 1s; exits when the
task finishes. Useful for watching a long-running routine without
opening the app.

```sh
$ jarvis run "summarise yesterday's meetings" --skill daily-recap --attach
launched 7H3Tb_8x9k — Generate daily recap…
[session abc123…]
Reading ~/.jarvis/meetings/2026-05-13-standup.md…
…
— completed · $0.0123
```

## Examples

### iOS Shortcut

Tap-to-Jarvis from your phone — set up a Shortcut with a single HTTP
action:

- **Method:** POST
- **URL:** `http://<your-mac-local-ip>:4747/v1/intent`
- **Headers:** `Authorization: Bearer <your token>`
- **Body (JSON):** `{ "prompt": "remind me in 1h to ship the patch" }`

(Bind the Mac IP via Continuity or a VPN. Don't bind 0.0.0.0 to the
server — keep it 127.0.0.1 for security.)

### Shell alias for inbox triage

```sh
alias ji='jarvis inbox'
ji
```

### Cron-style reminder from a script

```sh
# At the end of a long-running job:
jarvis intent "remind me right now: deploy is done"
```

## Limits

- macOS only (uses `security` for token discovery). Adding Linux/Windows
  support would mean reading the token from a fallback file.
- Streaming via `jarvis attach` is poll-based (1s interval). True
  Server-Sent-Events would land if the HTTP server grows that.
- The HTTP server binds 127.0.0.1 only. Remote access requires a tunnel
  / VPN.
