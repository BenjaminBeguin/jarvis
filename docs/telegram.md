# Telegram bot — pilot Jarvis from your phone

The Telegram module lets you act on what Jarvis is doing from anywhere —
trigger skills, see reminders, respond to "should I send this email?"
mid-task prompts. The phone is the **fast-response surface** for things
that demand attention; the desktop stays the cockpit for everything else.

Lives in [electron/main/modules/telegram-bot/](../electron/main/modules/telegram-bot/).
Long-polling via `telegraf`; no public URL, no tunnel, no cloud — your
Mac talks directly to Telegram's servers.

## What it does

**Inbound (phone → Jarvis):**

| You send | What Jarvis does |
|---|---|
| `daily brief` (text or voice) | Same dispatch as the palette — verbal intents, reminder parser, then a Claude task. Replies with the first-turn result. |
| Voice note | Decoded via bundled `ffmpeg` → Whisper → routed like text. |
| Reply to a bot message | Continues the *same* task in a multi-turn SDK session (`runner.sendMessage`). Iterate from phone without losing context. |
| Tap `[Approve]` / `[Edit…]` / `[Cancel]` on a cockpit prompt | Resumes the task, asks for more input, or aborts. |

**Outbound (Jarvis → phone):**

| Trigger | Reaches phone? |
|---|---|
| Reminder fires | Always — with `[Done]` / `[Snooze 1h]` / `[Snooze 1d]` buttons. |
| Scheduled action completes | Always. |
| Task hits `awaitingInput=true` ("Should I send this email?") | Yes — with `[Approve]` / `[Edit…]` / `[Cancel]` buttons. For tasks the bot started: always. For palette/routine tasks: only in AFK mode. |
| Task complete/errored | For tasks the bot started: covered by the reply. For others: only in AFK mode or when "Send to phone = all". |
| MCP `notify`, cost guardrail, meeting heads-up, inbox new-items | In AFK mode or when "Send to phone = all". |

## Setup (5 minutes)

### 1. Create a bot on Telegram

1. Open Telegram, message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Give it a name (anything) and a username ending in `bot` (e.g. `jarvis_yourname_bot`).
4. BotFather replies with an HTTP API token like `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`.
   Keep this tab open.

### 2. Paste the token into Jarvis

1. In Jarvis: top-right **⚙ Settings** → **Modules** → **Telegram bot** → click the tile.
2. In the modal, find **Bot token** → click **Set token** → paste → **Save**.
3. Token goes into the macOS Keychain (service `app.jarvis`, account
   `telegram-bot-token`). Jarvis reloads the module so the bot starts
   immediately. You don't have to restart the app.

### 3. Discover your chat ID

1. Back in Telegram, find your bot (by the username you set) and start a chat.
2. Send `/start`.
3. The bot replies with `Your chat id is 12345678…` (allowlist check is
   skipped for `/start` so discovery always works).
4. Copy that number.

### 4. Add your chat to the allowlist

1. Back in the Telegram bot settings modal → **Allowed chat IDs**.
2. Paste the number. Multiple IDs are comma-separated.
3. Save. The change applies immediately — the bot re-reads the allowlist
   on every message.

### 5. Send your first message

From Telegram: `/note buy milk` → the bot writes to today's notes file
and confirms. Or send a voice note: "remind me at 5pm to call mom" →
reminder gets scheduled; at 5pm your phone gets the reminder with
`[Done] [Snooze 1h] [Snooze 1d]` buttons.

## AFK mode

A cross-cutting toggle that widens what mirrors to phone. Three ways
to flip it:

- **Phone-icon button** in the Jarvis header (top-right, near the auth pill).
- **Tray menu** → "AFK mode (mirror to phone)" checkbox.
- **Telegram**: `/afk on` / `/afk off` / `/afk status`.

All three stay in sync via the `app:afkChanged` broadcast.

| Event | AFK off (default) | AFK on |
|---|---|---|
| Task from Telegram, awaiting input | → phone (cockpit) | → phone (cockpit) |
| Task from palette / routine, awaiting input | OS notification only | → phone with `[Approve] [Edit] [Cancel]`, bridged so a reply continues the task |
| Task from any origin, complete | Bot-originated only | Always → phone |
| Reminder fires | → phone | → phone |
| Scheduled action result | → phone | → phone |
| Meeting heads-up / cost guardrail / inbox new-items | OS only | → phone |
| `mcp__jarvis__notify` from inside a task | If "Send to phone = all" | → phone |

When AFK turns on and a palette-launched task hits awaiting-input, the
bot **adopts** the task into its bridge — your Telegram reply continues
the original task via `runner.sendMessage`, same SDK session. No
context-rebuild.

## Bot commands

| Command | Effect |
|---|---|
| `/start` | Echo your chat ID (works without allowlist). |
| `/skills` | List available skills with one-line descriptions. |
| `/status` | Run the `status` skill (a quick "what's on your plate"). |
| `/abort` | Abort the most recent task launched from this chat. |
| `/afk on` / `/afk off` / `/afk status` | Toggle AFK mode. |
| Anything else | Routes through the same dispatcher as the palette (verbal intents → modules → reminder parser → task). |

## Settings reference

In Jarvis → Settings → Modules → Telegram bot:

- **Bot token** — Keychain-backed. Stored in `app.jarvis` /
  `telegram-bot-token`. Never written to disk in plaintext, never sent
  to the renderer.
- **Allowed chat IDs** — comma-separated Telegram chat IDs that can
  talk to the bot. Empty = bot only responds to `/start`.
- **Send to phone** — `Reminders + scheduled actions + cockpit only`
  (default), `All notifications`, or `Nothing (inbound only)`. AFK mode
  effectively forces this to `all` while on.

All three are read fresh on every message and every outbound
notification — changes take effect immediately, no module reload.

## Privacy / security

- **Single-user.** The allowlist is your only chat ID(s). Other chats
  hit the bot, the bot ignores them (silently — Telegram still delivers
  the message to your server but the handler short-circuits).
- **Token in Keychain only.** The renderer can write/clear it but
  cannot read it back. The main process loads it at module-start and
  passes it to Telegraf in memory.
- **Long-polling, not webhook.** No inbound port opened, no public URL,
  no tunnel. Your Mac initiates every Telegram call.
- **End-to-end encryption: no.** Telegram's bot API is *not* E2E
  encrypted — Telegram servers can read bot messages. If that's a
  dealbreaker, this module isn't right for you. The codebase makes it
  easy to swap in a Signal or Matrix backend later.

## Troubleshooting

**Bot doesn't respond to /start**
- Check the token saved? Settings → Modules → Telegram bot — should
  show "✓ Token saved".
- Watch the Electron dev console for `[telegram-bot]` log lines.
- Token may have been revoked. Generate a new one with @BotFather (`/revoke`),
  paste it again.

**Bot ignores my messages but /start works**
- Allowlist is empty or your chat ID isn't in it. Send `/start`, copy
  the chat ID, paste into Allowed chat IDs, save.

**Voice notes fail in production DMG but work in `pnpm dev`**
- The bundled `ffmpeg-static` binary needs to be unpacked from
  `app.asar`. Check `electron-builder.yml` has:
  ```yaml
  asarUnpack:
    - "**/node_modules/ffmpeg-static/**"
  ```
  Rebuild the DMG.

**"awaitTurnResult timed out"**
- The task didn't produce a `result` event within 3 minutes. Either it's
  genuinely slow or it errored out. Look in the Observatory — your
  task ID will be in the bot's reply text.

**AFK toggle in the header doesn't match the tray**
- Both subscribe to `app:afkChanged`. If they diverge, restart the app.
  File an issue with steps to reproduce — there's a tray-menu refresh
  bug we'd want to know about.

## Architecture (one-screen)

```
┌──────────────┐  long-poll       ┌────────────────────────────────┐
│  Telegram    │ ◄────────────────│  electron/main/modules/        │
│  servers     │  getUpdates      │    telegram-bot/               │
└──────┬───────┘                  │      index.ts (Module entry)   │
       ▲ sendMessage              │      bot.ts (Telegraf wrapper) │
       │                          │      task-bridge.ts (maps)     │
                                  │      transcribe-ogg.ts (ffmpeg)│
                                  └──────────┬─────────────────────┘
                                             │ ctx.routePrompt()
                                             │ ctx.awaitTurnResult()
                                             │ ctx.sendMessageToTask()
                                             │ ctx.abortTask()
                                             │ notifier.subscribe()
                                             ▼
                            ┌─────────────────────────────────┐
                            │  Existing main process          │
                            │   intent-router, task-runner,   │
                            │   reminders, notifier.ts        │
                            └─────────────────────────────────┘
```

Key seams added for this module (reusable by any future remote-control
module):

- `electron/main/notifier.ts` — single fan-out for OS notifications.
  Subscribers can mirror to phone / watch / web.
- `electron/main/route-prompt.ts` — palette dispatch logic extracted
  so any caller (IPC, module, HTTP API) routes identically.
- `electron/main/await-turn.ts` — wait-for-turn helper that resolves
  on the first `result` event (multi-turn safe; **not** the same as
  status='completed').
- `ModuleContext` additions: `routePrompt`, `awaitTurnResult`,
  `sendMessageToTask`, `abortTask`, `isAfk`, `setAfk`,
  `listReminders`, `markReminderDone`, `snoozeReminder`, `listSkills`.

## What's intentionally out of V1

These are deferred — built into the design but not shipped yet. See
[NEXT.md](NEXT.md) for the full follow-up list.

- **Streaming responses** — V1 sends the final-answer message once the
  turn ends. Editing the Telegram message progressively (like the
  Answer HUD) would be richer but adds Telegram API call volume.
- **Browse commands** (`/tasks`, `/reminders`, `/inbox`, `/top`) — those
  are "browse" not "fast to act"; the mobile PWA dashboard (Phase 2)
  is the right surface.
- **File attachments** in either direction — meeting transcripts,
  briefing PDFs.
- **Persistent multi-turn bridge** — the `taskId ↔ chatId` map lives
  in memory; killed on app restart. Running tasks survive (the
  TaskRunner does) but the Telegram bot won't know which chat they
  belong to after a restart.
- **Per-chat allowlist tiers** — today one chat = full access. Future:
  read-only chats, action-restricted chats (no abort), etc.
- **Telegram-side rich formatting** — V1 sends plain text. MarkdownV2
  is supported by Telegram but the escape rules are finicky.
