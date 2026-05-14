# Backlog

Things we discussed but didn't ship. One file per feature; each has
**Why · What · How · Tradeoffs · Effort**. Read top-to-bottom in
priority order; pick whatever the day calls for.

## Tier 1 — high signal, build when daily-driver pain shows up

- [Daemon split](./daemon-split.md) — run main process on a Mac mini / VPS so reminders + scheduled actions fire even when the laptop is closed.
- [Calendar awareness + auto meeting detection](./calendar-aware.md) — read macOS Calendar, surface upcoming events in observatory, prompt `/meeting` when a meeting starts.
- [whisper.cpp swap](./whisper-cpp.md) — fully offline transcription, drop the Xenova/transformers.js dependency.
- [Skill chaining / workflow DAG](./skill-chaining.md) — a skill spawns another skill; parent → child task tree visible on the constellation.

## Tier 2 — meaningful UX wins

- [Smart palette suggestions](./smart-suggestions.md) — when the palette opens, show context-aware hints ("you have 2 PRs to review", "meeting in 5 min") instead of generic placeholders.
- [MCP "test connection" button](./mcp-test-button.md) — verify a freshly-saved MCP actually spawns + handshakes before the user closes the form.
- [Cost + time dashboard](./cost-dashboard.md) — spend per day, average task duration, most-used skills.
- [Reminder snooze + edit](./reminder-snooze-edit.md) — small UX gaps on existing reminders (15-min snooze, change time/body without recreating).
- [Action items extractor as a separate skill](./action-items-skill.md) — clean reusable flow, decoupled from meeting-debrief.

## Tier 3 — broader / longer

- [CLI: `brew install jarvis`](./cli.md) — terminal binary that talks to the running app. Deferred (we have `/sh` and `>` palette intents).
- [External / community modules](./external-modules.md) — load modules from `~/.jarvis/modules/<id>/` at runtime with a sandboxed worker bridge.
- [Multi-workspace Slack](./multi-workspace-slack.md) — second + third workspace alongside the primary.
- [Send as user, not as bot](./send-as-user.md) — Slack user-tokens (`xoxp-`) so messages are sent from your account.
- [Wake word](./wake-word.md) — "Hey Jarvis" hands-free trigger. Not built; needs lightweight wake-word detection.

## Recently shipped (so we don't re-discuss)

If you're looking for something you remember talking about and don't see
it here, it probably landed. Spot-check with `git log --oneline`.
