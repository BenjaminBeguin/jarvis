# Cost + time dashboard

## Why

Subscription mode bills against the user's Claude.ai quota; API mode
bills $$. Either way, "how much am I actually using Jarvis" is invisible
right now. `TaskSummary.costUsd` exists and is populated per-task but
nothing surfaces it.

## What

A new dashboard section (or its own tab under Observatory) showing:

- **Today** · total tasks, total cost, total wall time.
- **7-day chart** · cost per day (sparkline).
- **Top skills** · which skills you actually use, by count + cost.
- **Cost-per-skill heatmap** · which ones are expensive (long
  chains) vs cheap (one-shot).
- **Per-task drill-in** · click a row, see the breakdown by message.

## How (rough)

- All data is already in SQLite (`tasks` + `task_events` tables).
- New IPC `taskUsageStats(rangeDays?: number)` that aggregates:
  - SELECT date(startedAt), count(*), sum(costUsd) FROM tasks WHERE
    origin != 'external' GROUP BY date.
  - SELECT skillId, count(*), sum(costUsd) FROM tasks GROUP BY skillId.
- Renderer: a Stats view component. Probably uses Chart.js or hand-
  rolled SVG bars (we already have an SVG vocabulary).
- For API mode, costUsd is reliable. For subscription mode, the SDK
  reports a synthetic cost — note this as "approx".

## Tradeoffs / risks

- **Numbers in subscription mode are approximations**. Make this
  explicit in the UI so the user doesn't panic at a $4 day.
- **Privacy**. If we ever add cloud sync, the cost log is sensitive.
  Keep it local-only.

## Effort

~2 sessions. Data is already there; it's all UI.

## Related

- Phase 3 in CLAUDE.md mentions cost dashboard.
