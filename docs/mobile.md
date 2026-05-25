# Mobile PWA — Jarvis on your phone

Richer than the [Telegram bot](telegram.md): the mobile PWA gives you the
**full Inbox, every conversation transcript, voice dictate, and Web Push
notifications** — same surfaces as the desktop, touch-tuned. The Mac stays
the brain (single source of truth, single user); the PWA is a thin viewer
+ remote control reaching the HTTP API on port 4747.

Lives in [src/renderer/views/mobile/](../src/renderer/views/mobile/).
Server side is the existing HTTP API in
[electron/main/http-server.ts](../electron/main/http-server.ts) plus
[electron/main/push.ts](../electron/main/push.ts) for Web Push fan-out.

## What it does

| Surface on phone | What it shows / does |
|---|---|
| **Status header** | Mode pill (running / paused / autopilot), live counts (running · awaiting · scheduled · today's spend), connection dot. Updates over SSE every 5 s. |
| **Inbox** | Same items as desktop — PRs, reminders, calendar, smart-curated picks. Pull/tap-refresh. |
| **Threads** | Recent conversations + pinned. Tap → full transcript using the shared `buildItems` renderer. |
| **Reply composer** | Reply to a running task (multi-turn) or resume a completed one via its `sdkSessionId`. |
| **Dictate** | Hold-to-talk orb → MediaRecorder → `/v1/audio/dispatch` → Mac transcribes (Whisper) → routes like the desktop voice orb → opens the new conversation. |
| **Push notifications** | Web Push fan-out of every `notifier.post()` — same alerts as the desktop. Pause silences AUTO_SOURCES; task lifecycle still gets through. |

## Prerequisites

- **Tailscale** on the Mac AND the phone, signed into the same account.
  This is the transport — no public URL, no tunnel, no cloud relay.
  ([Tailscale install →](https://tailscale.com/download))
- **Jarvis running on the Mac** in either `pnpm dev` or a built `dist:mac` app.
  The HTTP API auto-binds `0.0.0.0:4747` so the Tailscale interface is
  reachable.
- **A modern browser on the phone.** iOS 16.4+ (Safari) or recent Chrome
  on Android. Older iOS doesn't support Web Push for PWAs.

## Setup (5 minutes)

### 1. Install Tailscale

On the Mac:

```sh
brew install --cask tailscale
open -a Tailscale   # sign in via the menu-bar app
```

On the phone: install **Tailscale** from the App Store / Play Store, sign
into the same account. You don't need a static IP — Tailscale's MagicDNS
gives both devices stable `<host>.<tail-net>.ts.net` hostnames.

### 2. Find your Mac's Tailscale hostname

Click the Tailscale menu-bar icon → your Mac is listed under "This device".
Example: `admins-macbook-pro.tail1915a6.ts.net`. No port, no protocol.

### 3. Open the pairing panel in Jarvis

In the Jarvis desktop app: top-right **⚙ Settings** → **Mobile**.

1. Paste your Tailscale hostname into the field.
2. Pick a target:
   - **Dev server (vite :3010)** — use this if you're running `pnpm dev`.
     The PWA loads from Vite's HMR server; API calls still go to `:4747`.
   - **Production build (:4747/mobile)** — use this for a built app.
     The HTTP server serves the bundled renderer at `/mobile`.
3. A QR code appears.

### 4. Pair the phone

Open the phone's camera (iOS) or Google Lens (Android), point it at the
QR. A link appears — tap it. The PWA loads, persists the embedded
`{ baseUrl, token }` to localStorage, and lands on the Inbox.

The pairing URL the QR encodes looks like:
`http://<host>:3010/#/mobile?pair=<base64-json>`. You can also click
**Copy full URL** and message it to yourself.

### 5. Add to home screen (optional but recommended)

**iOS Safari:** tap **Share → Add to Home Screen**. The icon installs;
opening it launches the PWA standalone (no Safari chrome).

**Android Chrome:** ⋮ menu → **Install app** (or "Add to Home Screen").

Standalone install is required for iOS Web Push to work.

### 6. Grant notifications

On first launch after pairing, the PWA asks for **Notifications**
permission. Tap allow — the SW subscribes against the server's VAPID
public key, POSTs the subscription to `/v1/push/subscribe`, and the Mac
fans every `notifier.post()` event to your phone from then on. Pause on
the Mac still silences `AUTO_SOURCES` (cron-fired reminders, calendar,
inbox-new) — task lifecycle events still come through.

## Local testing on the Mac

You don't need to pull out your phone to iterate. Three options:

| What | URL | Notes |
|---|---|---|
| **Plain Chrome tab** | `http://localhost:3010/#/mobile` (dev) or `http://localhost:4747/mobile` (prod) | Use Cmd+Shift+M to enable iPhone device emulation. |
| **Installed PWA** | Click the install icon in Chrome's URL bar | Standalone window, real SW, Web Push works. |
| **Real phone over Tailscale** | The QR target | The actual deployment target. |

For the localhost path, generate the QR with hostname `localhost` in the
Settings panel and copy the URL — that produces a pairing payload with
`baseUrl=http://localhost:4747`, which works in any Chrome tab on the Mac.

## Architecture

```
┌────────────────────────────────────────────┐
│ Mac (Jarvis Electron app, always-on)       │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ HTTP server :4747 (bind 0.0.0.0)     │  │
│  │  GET  /v1/status         (open)      │  │
│  │  GET  /v1/inbox          (auth)      │  │
│  │  GET  /v1/tasks          (auth)      │  │
│  │  GET  /v1/tasks/:id      (auth)      │  │
│  │  POST /v1/tasks/:id/message (auth)   │  │
│  │  POST /v1/audio/dispatch (auth)      │  │
│  │  GET  /v1/status/live    (auth, SSE) │  │
│  │  GET  /v1/push/key       (auth)      │  │
│  │  POST /v1/push/subscribe (auth)      │  │
│  │  POST /v1/push/unsubscribe (auth)    │  │
│  │  GET  /mobile            (renderer)  │  │
│  └──────────────────────────────────────┘  │
│                  ▲                         │
│         Tailscale tail-net.ts.net hostname │
│                  │                         │
└──────────────────┼─────────────────────────┘
                   │
                   ▼
         ┌──────────────────────────┐
         │ Phone (PWA, home-screen) │
         │  /#/mobile shell + tabs  │
         │  service worker (push)   │
         │  Web Push subscription   │
         └──────────────────────────┘
```

### Auth

- One bearer token, auto-generated on first Jarvis launch, stored in macOS
  Keychain (service `app.jarvis`, account `jarvis-http-api-token`).
- Every endpoint except `/v1/status` and `/oauth/callback/*` requires
  `Authorization: Bearer <token>`. SSE accepts `?token=` query fallback
  because `EventSource` can't send custom headers.
- The QR encodes `{ baseUrl, token }` as base64 JSON. The phone persists
  it to localStorage keyed `jarvis.mobile.auth`. "Sign out" clears it.
- Rotate from desktop Settings → API → Rotate. Existing phones lose
  access immediately; re-pair to get the new token.

### Live updates (SSE)

`GET /v1/status/live` returns `text/event-stream`. Three event types:

| Event | Payload | Fires on |
|---|---|---|
| `status` | full `TrayMenuState` snapshot | every 5 s + on any task status change |
| `notif` | `NotificationEvent` (title, body, source, taskId?) | every `notifier.post()` |
| `task.status` | `TaskSummary` | every TaskRunner status change |

`EventSource` reconnects automatically on drop. Keepalive comments
(`: keepalive\n\n`) prevent idle proxies / Tailscale-thru-radio from
killing the connection.

### Web Push

- VAPID keypair generated once at boot, persisted in Keychain
  (account `jarvis-vapid`). The same pair survives app restarts so the
  phone's subscription stays valid.
- The PWA fetches the public key from `/v1/push/key`, calls
  `pushManager.subscribe()`, POSTs the result to `/v1/push/subscribe`.
  Subscriptions live at `~/.jarvis/push-subscriptions.json` keyed by
  an opaque device id the PWA generates.
- A `notifier.subscribe()` handler in `electron/main/index.ts` calls
  `pushToAll(payload)` on every event. Stale endpoints (HTTP 410/404 from
  the push service) get pruned on the next fan-out.
- Service worker shows the notification (tag = `task:<id>` or
  `reminder:<id>` so repeats collapse). Tap → focus an open PWA window
  or open one fresh at `/#/mobile?view=conversation&id=<taskId>`.

### Audio dispatch

`POST /v1/audio/dispatch` accepts a raw audio blob (any container —
MediaRecorder defaults to `audio/webm` on Android, `audio/mp4` on iOS).
Server-side:

1. Decode → 16 kHz mono PCM via bundled `ffmpeg-static`
   ([electron/main/audio-dispatch.ts](../electron/main/audio-dispatch.ts))
2. Transcribe via the forked Whisper worker
   ([electron/main/modules/voice/transcribe.ts](../electron/main/modules/voice/transcribe.ts))
3. Dispatch the resulting text through `routePrompt` with `origin: 'voice'`
4. Return `{ taskId, text }` so the PWA navigates straight to the new
   conversation.

## Troubleshooting

### "Failed to fetch" on the phone

The API base URL saved by the PWA can't reach the Mac. Check:

1. **Tailscale is up on both ends.** Menu-bar app on Mac, Tailscale app
   running on phone. Both signed into the same tailnet.
2. **The hostname matches.** Open the phone's PWA, DevTools (if pairing
   via Mac Chrome), look at the saved `auth.baseUrl`. It should be
   `http://<your-mac>.<tail-net>.ts.net:4747`. If the port is wrong (e.g.
   `:3010`), re-pair via Settings → Mobile with the hostname filled in
   correctly.
3. **`/v1/status` is reachable.** From the phone's browser, hit
   `http://<host>:4747/v1/status` directly. Should return
   `{"ok":true,"name":"jarvis","version":"0.0.1"}`. If it hangs, the Mac's
   firewall is blocking inbound on `:4747` — check System Settings →
   Network → Firewall.
4. **Vite dev allowedHosts.** If you're on dev mode (`pnpm dev`) and Vite
   logs `Blocked request. This host (...) is not allowed`, the wildcard
   in [electron.vite.config.ts](../electron.vite.config.ts) under
   `server.allowedHosts` must cover your tailnet (the default `.ts.net`
   does this).

### Browser hangs / `Provisional headers are shown`

Usually one of:

- **An extension is blocking the request.** Open in Incognito with all
  extensions disabled; if it works there, ad-blockers / privacy
  extensions are the culprit (allowlist your tailnet hostname).
- **A stale service worker.** DevTools → Application → Service Workers →
  Unregister, hard-reload (Cmd+Shift+R).
- **Mixed-content blocking.** Both the PWA origin and the API origin must
  be `http://` (no HTTPS on either since the API is plain HTTP). If you
  somehow ended up on `https://`, re-pair.

### Push notifications never arrive

1. **Browser support.** iOS needs 16.4+ AND the PWA must be installed to
   the home screen (not just an open Safari tab). Android Chrome works
   from any tab.
2. **Permission granted.** iOS: Settings app → Notifications → Jarvis.
   Android: long-press PWA icon → App info → Notifications.
3. **Server can reach the push service.** The Mac needs internet access
   to push to Apple's / Mozilla's / Google's push endpoint. Tailscale-only
   networks won't work for push fan-out.
4. **VAPID keys not rotated.** If you cleared Keychain, the keys
   regenerated and existing subscriptions are dead. Re-pair the phone.

### Mic upload fails ("audio too short" / "audio decode failed")

- `ffmpeg-static` must be installed (it's a dep of the voice module;
  reinstall with `pnpm install` if you see decode errors).
- The blob must be >= ~300 ms of audio. Hold the orb longer.
- iOS sometimes returns an empty blob if you don't grant mic permission
  on the first press. Settings → Safari → Microphone.

### Inbox / threads don't update live

The SSE stream is the live channel. If you see `Reconnecting…` in the
header dot, the EventSource is failing. Common causes:

- **Tailscale interface flapping** (phone went to sleep, wifi/cellular
  handoff). `EventSource` reconnects automatically on the next poll;
  pull-to-refresh forces an immediate fetch.
- **Long Mac sleep.** macOS may suspend the HTTP server when the lid is
  closed. Wake the Mac.

## Limits + scope

- **Single user, single device pairing per phone.** No multi-user. The
  bearer token in the QR == "the keys to the kingdom" — same threat model
  as your Mac password.
- **No cloud variant.** Mac stays the brain. If you want anywhere-access
  beyond Tailscale, add a Cloudflare Tunnel transport on top — the bearer
  auth + endpoints stay the same.
- **No offline mode.** The SW caches static assets so the shell loads
  cold, but Inbox / threads / dictate all need the Mac live. No queueing
  of offline-composed messages.
- **Notification preferences per source not yet exposed.** Every
  `notifier.post()` fans out the same way. A per-source toggle UI lands
  in a later commit.
- **Background sync of inbox while PWA is closed** is not implemented —
  iOS Safari periodic-background-sync support is too thin to bother.

## Files

- [electron/main/http-server.ts](../electron/main/http-server.ts) —
  endpoints + SSE + bearer auth.
- [electron/main/push.ts](../electron/main/push.ts) — VAPID + subscription
  store + `pushToAll()`.
- [src/renderer/views/mobile/](../src/renderer/views/mobile/) — PWA app
  (MobileApp, MobileShell, MobileInbox, MobileConversations,
  MobileConversation, MobileDictate, MobileLogin, hooks).
- [src/renderer/sw/sw.ts](../src/renderer/sw/sw.ts) — service worker
  (precache + push + notificationclick).
- [src/renderer/views/MobilePairingPanel.tsx](../src/renderer/views/MobilePairingPanel.tsx) —
  desktop Settings → Mobile QR generator.
- [electron.vite.config.ts](../electron.vite.config.ts) — `vite-plugin-pwa`
  config + dev server `allowedHosts`.
