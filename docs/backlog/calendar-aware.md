# Calendar awareness + auto meeting detection

## Why

Two related gaps:

1. The observatory shows everything happening _now_, but nothing about
   what's _about to_ happen. "Meeting in 5 min" is useful context.
2. The user has to manually fire `/meeting` to start recording. Catching
   a meeting starting in Zoom / Meet / Teams / FaceTime is something the
   OS already knows about.

## What

- A new "Calendar" feed: today's events appear as faded inner-ring
  nodes on the constellation, color-coded by start time. Click → see
  details, jump to a meeting link.
- When a meeting begins (calendar event hits start time AND a known
  meeting app is in the foreground / has an active window), Jarvis pops
  a 5-second native notification: "Start recording <event title>?"
  Accept → fires `/meeting <title>` automatically.

## How (rough)

- **Calendar source**: macOS Calendar via `EventKit`. Either:
  - A small native helper (Swift, signed) — most reliable, requires
    permission prompt for Calendar access.
  - Or: read iCal feeds from `~/Library/Calendars/`. No permission
    prompt but harder to interpret.
  - Or: prompt the user to subscribe Jarvis to a webcal:// URL.
  Native helper is the right answer long-term.
- **Active app detection**: `child_process` running `osascript -e 'tell
  application "System Events" to name of first application process
  whose frontmost is true'`. Poll every 5s while a calendar event is
  within ±2 min of now. Cheap enough.
- Meeting app allowlist: `zoom.us`, `Google Chrome` (with a `meet.google.com`
  tab — needs Chrome extension or active-tab read), `Microsoft Teams`,
  `FaceTime`, `Slack`. Conservative: only fire if a known app is
  frontmost; otherwise just show the notification without auto-record.
- New module: `calendar` with one intent (`/meeting-from-event <id>`)
  and one onLoad hook that runs the poll loop.

## Tradeoffs / risks

- **Permission churn**. Calendar access is a system dialog. iCal-only
  approach skips it but loses real-time updates (calendar files don't
  push).
- **Meeting app heuristics get wrong**. User in Zoom for a non-event
  call (1:1 chat) → false positive. Mitigate: only auto-record if a
  calendar event matches the time. Otherwise just show the notification.
- **Privacy weight**. Reading calendar = sensitive data flowing through
  Claude tasks. Document this; let the user opt out per-event.

## Effort

~3-4 sessions. Native helper is the biggest chunk; iCal-only could ship
in one if we don't need realtime.

## Related

- Meeting recorder (shipped) — auto-trigger feeds into the same
  `/meeting` intent.
- [Smart palette suggestions](./smart-suggestions.md) — share the
  upcoming-events fetch.
