# Reminder snooze + edit

## Why

Today's reminder controls are: create, cancel, run-now (via map
popover). Two missing gestures:

- **Snooze** — "push this 15 min later". Common when a reminder fires
  but I'm in the middle of something.
- **Edit** — change the body or fire time without cancel + recreate.
  Especially useful for body tweaks ("oh I meant 4pm not 3pm").

## What

On the reminder action popover (the amber menu on the constellation
node), add two more actions:

- **Snooze** → submenu with `15m`, `1h`, `tomorrow morning`, `custom…`.
- **Edit** → opens a small inline form (body textarea + datetime
  picker) populated with current values.

Same flow on the dashboard reminder rows.

## How (rough)

- `ReminderStore` already has timer management. Add:
  - `snooze(id, deltaMs)` — clears the current timer, bumps fireAt,
    re-schedules.
  - `update(id, patch: { body?, fireAt? })` — same, with body change
    too.
- New IPC channels: `snoozeReminder(id, deltaMs)`,
  `updateReminder(id, patch)`. Preload methods.
- UI: reuse the existing popover; add a `▾ Snooze` submenu and an
  `Edit` button that swaps the popover content for an inline form.

## Tradeoffs / risks

- **Custom datetime picker** is the only chunky bit. Native `<input
  type="datetime-local">` is hideous but functional; can be styled
  later.

## Effort

~1 session.

## Related

- Reminders (shipped).
