# Meeting recorder — heads-up prompts + recording controls

Jarvis can record any meeting, transcribe it locally via Whisper, and
save the transcript as markdown you can push to Claude for action-item
extraction. Three detection paths feed one heads-up prompt:

1. **macOS Core Audio watcher** — fires when ANY app opens the mic or
   camera (Meet, Zoom, Teams, Discord, FaceTime, GarageBand, you name it).
   No setup; just works on macOS.
2. **Chrome extension** — pings Jarvis when you join a Meet / Zoom /
   Teams / Whereby call in the browser. More reliable than Core Audio
   on macOS 15+ where coreaudiod went quiet.
3. **Manual** — `/meeting [title]` in the palette, or the verbal
   "record this meeting".

All three land on the same prompt + recording overlay.

## What it does

```
┌────────────────────────────┐
│ Meeting in progress         │  ← top-right toast,
│ Engineering standup         │     auto-dismisses in 90s
│ Detected via extension · meet│
│ [🎙 Record] [Join] [Skip]   │
└────────────────────────────┘

… click Record ↓

┌──────────────────────────────────────────────┐
│ ● Engineering standup                         │  ← floating overlay,
│   REC · 04:12 · ✦                            │     survives nav
│ [▾] [❚❚ Pause] [✕] [Finish]                  │
└──────────────────────────────────────────────┘

… click Pause ↓

┌──────────────────────────────────────────────┐
│ ○ Engineering standup                         │
│   PAUSED · 04:12                              │
│ [▾] [▶ Resume] [✕] [Finish]                  │
└──────────────────────────────────────────────┘
```

**Pause** drops samples while keeping the mic open (no re-prompt on
resume; the live clock freezes on the audible time).
**Cancel** (✕) discards the recording — no transcript saved.
**Finish** transcribes + writes
`~/.jarvis/meetings/<ts>-<slug>.md`.

The overlay sticks around across tab navigation, so you can take notes
in another module while the meeting captures.

## Quick start

You don't have to set anything up — the macOS watcher runs on first
launch. Hit ⌘⇧J → `/meeting standup` to test manually.

### Optional: Chrome extension for reliable browser-meeting detection

macOS 15 (Sequoia) muted coreaudiod's input-event channel, so the
"mic went hot" detection fires inconsistently for browser-hosted
meetings. The extension closes that gap — it watches the DOM on
Meet / Zoom / Teams / Whereby tabs and pings Jarvis the moment you've
actually joined a call.

1. Open Chrome → `chrome://extensions/`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** → pick this repo's
   [`chrome-extension/`](../chrome-extension) folder.
4. The extension icon appears in your toolbar. Click it.
5. Fill in:
   - **Jarvis URL** — `http://127.0.0.1:4747` (same Mac) or
     `http://<mac>.<tail-net>.ts.net:4747` (over Tailscale).
   - **Bearer token** — copy from the desktop app under **Settings → API**.
6. Click **Save**, then **Test**. You should see
   `Connected · jarvis v0.0.1`.

From then on: open a Meet tab, join the call, and Jarvis pops the
"record this meeting?" heads-up within ~2 seconds.

## Pairing with Tailscale

If your work browser is on a different machine than the Mac running
Jarvis (e.g. work laptop ↔ home Mac), use the Tailscale URL in the
extension settings. The HTTP API binds `0.0.0.0:4747` so the Mac is
reachable from any device on your tailnet. See
[docs/mobile.md](mobile.md) for the broader Tailscale setup.

## Architecture

```
┌─ Chrome (browser tab) ──────────┐
│  content.js polls DOM,          │   when call detected:
│  detects "joined call" state ───┼──> chrome.runtime.sendMessage
│                                  │
│  background.js (service worker) ─┼──> POST /v1/meeting/detected
└──────────────────────────────────┘     { source, vendor, title, url }
                                              │
                                              ▼
┌─ Mac (Jarvis Electron) ─────────────────────────────────────┐
│  http-server.ts                                              │
│   /v1/meeting/detected ──> onExternalMeetingDetected(payload)│
│                                  │                            │
│                                  ▼                            │
│  fireMeetingHeadsUp(item) ◀── meeting-activity-watcher       │
│        │                       (Core Audio path,             │
│        │                        same funnel)                 │
│        ▼                                                     │
│  meetingImminent IPC ──> MeetingPrompt.tsx (renderer toast)  │
│                                  │                            │
│                                  ▼ user clicks Record         │
│                          meeting-recorder module              │
│                          /meeting palette intent              │
│                                  │                            │
│                                  ▼                            │
│                          MeetingRecorder (renderer)           │
│                          AudioCapture → Whisper worker        │
│                          → ~/.jarvis/meetings/*.md            │
└──────────────────────────────────────────────────────────────┘
```

### Files

- [chrome-extension/manifest.json](../chrome-extension/manifest.json) — MV3 manifest
- [chrome-extension/background.js](../chrome-extension/background.js) — POSTs detections to `/v1/meeting/detected`
- [chrome-extension/content.js](../chrome-extension/content.js) — per-vendor DOM heuristics
- [chrome-extension/popup.html](../chrome-extension/popup.html) — URL + token configuration UI
- [electron/main/meeting-activity-watcher.ts](../electron/main/meeting-activity-watcher.ts) — Core Audio + CMIO watcher
- [electron/main/modules/meeting-recorder.ts](../electron/main/modules/meeting-recorder.ts) — `/meeting` + `/meeting-stop` palette intents
- [src/renderer/voice/MeetingRecorder.ts](../src/renderer/voice/MeetingRecorder.ts) — renderer-side state + pause/resume/cancel/stop
- [src/renderer/voice/AudioCapture.ts](../src/renderer/voice/AudioCapture.ts) — 16 kHz mono PCM via MediaStream
- [src/renderer/views/MeetingOverlay.tsx](../src/renderer/views/MeetingOverlay.tsx) — floating overlay with controls
- [src/renderer/views/MeetingPrompt.tsx](../src/renderer/views/MeetingPrompt.tsx) — "record this meeting?" heads-up

## Recording controls

| Control | Behaviour | When you'd use it |
|---|---|---|
| **❚❚ Pause** | Drops incoming samples while keeping the mic + AudioContext open. Clock freezes on the audible time so what you see matches the saved transcript length. | Break / private aside / mic check |
| **▶ Resume** | Un-flips the pause flag; recording continues seamlessly. No re-prompt for mic permission. | Continue after pause |
| **✕ Cancel** | Discards the recording — no transcript written. Confirm-prompt first so a misclick doesn't lose work. | "This was a mistake / dry run" |
| **Finish** | Transcribes via Whisper + writes `~/.jarvis/meetings/<ts>-<slug>.md`. The Meetings page surfaces the file. | End of meeting |

## Detection heuristics (Chrome extension)

| Vendor | Signal |
|---|---|
| Google Meet | URL matches `/<3-letter>-<4-letter>-<3-letter>` + "Leave call" button in DOM |
| Zoom (web client) | URL matches `/wc/<id>/start` OR "Leave" button in DOM |
| Microsoft Teams | DOM element with `data-tid="hangup-button"` |
| Whereby | DOM element with `aria-label*="Leave room"` |

Polling: every 2 s for the first 60 s after page load + on every
SPA navigation. Once a join is detected, the tab marks itself "in
meeting" and stops polling. The background worker dedupes by
`(tabId, vendor, minute)` so a single tab can't spam Jarvis.

## Troubleshooting

### Extension popup says "Couldn't reach Jarvis"

- Jarvis isn't running, OR
- The bearer token is stale (rotate from Settings → API → Rotate, paste again), OR
- The URL has the wrong port (always `:4747`).

Test directly: `curl -H "Authorization: Bearer <token>" http://127.0.0.1:4747/v1/status` should return `{"ok":true,…}`.

### The heads-up never fires on macOS even without the extension

macOS 15+ frequently emits zero coreaudiod heartbeats. The auto-detect
shows "quiet" in Settings → Notifications when this happens. Two
fallbacks: install the extension (browser path doesn't depend on
coreaudiod), or just hit `/meeting` in the palette.

### Recording starts but the live transcript is empty

- Mic permission was denied. macOS Settings → Privacy & Security →
  Microphone → grant access to the Jarvis app, restart.
- Whisper model is still downloading on first use (~150 MB). Wait a
  minute, try again. The model lives at `~/.jarvis/models/`.

### "I clicked Pause but the clock kept ticking"

The clock shows the **paused-at** value while paused, not live wall
clock. If you see numbers continuing to change, the pause toggle
didn't catch — refresh and try again.

## Limits + scope

- **macOS only for Core Audio detection.** The Chrome extension is
  cross-platform (Mac/Windows/Linux Chrome), but the auto-detect
  watcher is darwin-only.
- **Chrome only** for the extension. Safari and Firefox would each
  need their own port; manifest v3 doesn't translate cleanly.
- **No per-app filter.** Both detection paths fire on ANY mic-using
  app — the heads-up always asks before recording, so false positives
  (Voice Memos, dictation, GarageBand) are cheap to dismiss.
- **No active-noise-cancellation tuning.** We pass `echoCancellation`
  + `noiseSuppression` constraints to `getUserMedia` and let Chromium
  handle it. Quality is fine for meetings, would be terrible for
  music.
- **No browser-shared-audio capture.** What gets recorded is your
  microphone (your half of the call). To capture remote participants
  too, the meeting platform's built-in record + their transcript export
  remains the right tool.
