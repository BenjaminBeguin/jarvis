# Smart palette suggestions

## Why

Right now when you ⌘⇧J the palette, placeholder text rotates through
generic capability hints ("remind me in 2h…", "/status", etc). Useful
for discoverability the first few weeks; less useful after that.

The data Jarvis already has on disk (reminders, awaiting tasks, recent
notes, calendar if wired, PR review queue) could feed concrete
suggestions: **"5 PRs waiting for your review"**, **"meeting in 4 min:
Standup"**, **"reminder due in 12 min: ship the patch"** — clickable to
act, dismissible to ignore.

## What

When the palette opens and the input is empty, surface a small column
of 3-5 contextual suggestions above the input bar. Each is a button:
- Click → fires the relevant action (e.g. opens the PR review queue,
  joins the meeting).
- × dismisses for this open session.

Suggestions disappear the moment the user starts typing.

## How (rough)

- A new `paletteSuggestions` IPC that returns an ordered list of
  `{id, label, kind, action: {moduleId?, intentId?, params?}}`.
- Source signals to consider:
  - Pending awaiting tasks (have you replied to all the agents?)
  - Reminders firing in the next 30 min.
  - PRs in review queue (cheap-cache the count from a periodic
    `gh pr list --search review-requested:@me`).
  - Calendar events within ±5 min.
  - The last interrupted task ("Resume Q3 analysis?").
- Rank by urgency: imminent reminder > meeting now > awaiting reply >
  PR queue > note from last hour.
- The palette renders them inline above the input bar; clicking
  dispatches an intent (same routing as a regular intent match).
- Refresh on each palette open (cheap calls only; the gh fetch should
  be cached + refreshed in the background).

## Tradeoffs / risks

- **Notification fatigue**. If the suggestions are always there, the
  user starts ignoring them. Pick aggressive threshold for what counts
  as "worth surfacing".
- **Latency**. Some signals (gh CLI) are slow. Run them in the
  background, cache, never block palette open.
- **Privacy**. The palette window is transparent + always-on-top; if
  you screenshare with it open, your PR queue + calendar leak. Probably
  fine but worth flagging.

## Effort

~3 sessions. Each signal source is small; the orchestration + ranking
is the real work.

## Related

- [Calendar awareness](./calendar-aware.md) — same fetch can feed
  suggestions.
