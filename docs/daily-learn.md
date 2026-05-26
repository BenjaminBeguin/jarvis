# Daily learn — Jarvis gets sharper from use, not configuration

The daily-learn loop is the **closing piece** of Jarvis's learning
substrate. Every weekday at 18:00, an agent reads what you actually
did today — what you dismissed, which drafts you sent verbatim, which
palette prompts you repeated, which skills you escalated — and writes
two files:

- **A daily journal** at `~/.jarvis/learnings/<YYYY-MM-DD>.md`:
  human-readable, scrolls back, evidence-driven inferences.
- **A running consolidated view** at
  `~/.jarvis/learnings/inferred-priorities.md`: rewritten daily from
  a rolling 14-day window. The smart inbox curator + work-awareness
  loop read this file alongside your explicit priorities files, so
  the substrate gets sharper without you touching any config.

The loop **never auto-applies** a config change. The user is always
in the loop. But because downstream skills consume the inferred file
automatically, the system compounds over days even if you never copy
anything into your explicit config.

## Why this matters

Before daily-learn, every preference was something you had to teach
explicitly: edit `inbox-priorities.md`, fill in
`work-awareness-priorities.md`, click checkboxes in module settings.
Smart products INFER. They watch behaviour and update their own
priors.

Concrete examples of what the loop catches:

| What it sees | What it proposes |
|---|---|
| You dismissed 14× `lgtm` PR comments this week | Add `lgtm comments` to mute patterns |
| @theo: 8 mentions + 3 PR reviews + 12 DMs in 7d | Add `@theo` to priority people (if not already) |
| `work-awareness` escalated 3× in past 7d | Bump default tier from `fast` → `balanced` |
| Palette: "what's the status of csai" 4× this week | Save as a skill OR pin to morning brief |
| `autopilot-slack-dm-ack` sent verbatim 8/10 times | Working well — keep enabled |
| `autopilot-pr-comments-on-mine` sent 2/8 times | Low precision — propose disabling or lowering cadence |
| 2 meeting action items aging out without follow-up | Surface in tomorrow's first prompt |

The journal is the audit trail. The inferred file is the running
state other skills consume.

## What it reads

| Source | Used for |
|---|---|
| `mcp__jarvis__recent_activity` (or sqlite `activity_events`) | task escalations, manual config edits, workflow health, meeting/reminder fires |
| `~/.jarvis/inbox/.dismissed.json` + `~/.jarvis/inbox/*.json` | which items you killed, what shape they had → mute candidates |
| `mcp__jarvis__list_drafts` | sent-verbatim vs discarded rates per autopilot source |
| `mcp__jarvis__list_tasks` (or sqlite `tasks` table) | repeated palette prompts, escalation patterns, cost outliers |
| `~/.jarvis/meetings/**/*.md` + `~/.jarvis/notes/**/*.md` | recurring collaborators tagged in action items |
| `~/.jarvis/inbox-priorities.md`, `work-awareness-priorities.md`, `config.json` | so it never proposes duplicates of your explicit config |

Graceful degrades when MCPs/files are missing — writes a minimal
"quiet day" journal and exits cleanly.

## The output shapes

### Daily journal

```markdown
# Daily learnings · 2026-05-26

## Day at a glance
- Tasks: 23 (12 palette, 7 routine, 4 autopilot)
- Drafts: 6 created, 4 sent (3 verbatim, 1 edited), 2 discarded
- Dismissals: 9 inbox items
- Escalations: 2 (work-awareness × 2)
- Cost: $1.24

## What worked
- autopilot-slack-dm-ack: 3/3 sent verbatim — keep on
- /status: 4 invocations, all returned in < 2s

## What didn't
- Repeated "summarise yesterday" 3× (same prompt, slightly
  different wording) — friction signal
- 2 drafts in autopilot-gmail-triage discarded — tone off

## Inferred (proposed for the user to accept)
### Priority people to add
- @anna (5 PR reviews + 6 mentions in #squad-mx this week)

### Mute candidates
- "lgtm" / "+1" PR comments — dismissed 14× this week

### Skill tier suggestions
- work-awareness: bump from fast → balanced (escalated 2× today,
  5× this week)

### Cadence suggestions
- autopilot-gmail-triage: lower from 15m → 1h (low send rate)

## Friction signals
- "summarise yesterday" asked 3× — consider a saved skill

## Next-day priorities
- #421 awaiting your review (5 days old)
- Theo's standup 11:30 — no prep yet
```

### Running inferred-priorities

```markdown
# Inferred priorities — auto-maintained

This file is rewritten daily by the `daily-learn` skill from your
recent behaviour. The user's manually-edited
`inbox-priorities.md` + module settings ALWAYS win; this is
supplemental signal.

Last updated: 2026-05-26T18:00:00Z

## Inferred priority people
- @theo — last evidence: 2026-05-26; signal strength: strong
  - Last 14d: 18 mentions, 7 PR interactions, 22 DM threads
- @anna — last evidence: 2026-05-25; signal strength: moderate
  - Last 14d: 8 PR reviews, 12 mentions

## Inferred priority channels
- #squad-mx — strong (8 of your last 10 mentions came from here)

## Inferred mutes
- "lgtm" / "+1" PR comments — dismissals last 14d: 38
- #standup-bot channel — dismissals last 14d: 17

## Inferred skill tiers
- work-awareness: balanced (escalated 5× in past 14d)
- pr-review-queue: balanced (escalated 3× in past 14d)
```

## Module

This is the `daily-learn` module. Find it at **Settings → Modules
→ Daily learn** for the declared memory map.

Palette intents:

- `/daily-learn` — fire the workflow now (don't wait for 18:00).
  Useful right after a heavy session when signals are still fresh.
  Verbal triggers: *"learn from today"*, *"what did you learn
  today"*, *"what patterns do you see"*.
- `/learnings` — opens `~/.jarvis/learnings/` in Finder. Lands on
  the inferred-priorities.md file when present.

## Files

- `~/.jarvis/skills/daily-learn/SKILL.md` — agent body
- `~/.jarvis/workflows/daily-learn-loop.json` — cron `0 18 * * 1-5`,
  default enabled
- `~/.jarvis/learnings/<YYYY-MM-DD>.md` — daily journals (output)
- `~/.jarvis/learnings/inferred-priorities.md` — running view (output)

## How the loop closes

```
       ┌───────────────────────────────────┐
       │ User behaviour today              │
       │  (dismissals, drafts, prompts,    │
       │   escalations, meetings)          │
       └─────────────┬─────────────────────┘
                     │
                     ▼
       ┌───────────────────────────────────┐
       │ daily-learn skill (18:00 weekdays)│
       │  reads ALL of the above           │
       │  writes journal + inferred-md     │
       └─────────────┬─────────────────────┘
                     │
                     ▼
       ┌───────────────────────────────────┐
       │ ~/.jarvis/learnings/              │
       │   <date>.md       (human audit)   │
       │   inferred-priorities.md          │
       └─────────────┬─────────────────────┘
                     │ next tick
                     ▼
       ┌───────────────────────────────────┐
       │ inbox-curate + work-awareness     │
       │  read the inferred file alongside │
       │  the user's explicit priorities   │
       │   (user's config always wins)     │
       └─────────────┬─────────────────────┘
                     │
                     ▼
       ┌───────────────────────────────────┐
       │ Smarter outputs in the Inbox      │
       │  → influences user behaviour      │
       │   tomorrow → daily-learn picks    │
       │   THAT up next 18:00              │
       └───────────────────────────────────┘
```

Each loop iteration sharpens the priors. Two weeks in, you should
notice less explicit configuration needed — Jarvis figured out who
matters, what counts as noise, which skills need more reasoning.

## Cost envelope

The skill is balanced-tier (sonnet). Once per weekday × ~30s of
work × ~5K input tokens × ~1K output ≈ **$0.02-0.05 per day**.
Cheaper than letting an autopilot draft fail and need redo.

## Limits + opt-out

- **First-run lands a journal.** Even on day one with no
  accumulated signal, the loop writes a "quiet day" file. Useful
  baseline.
- **You can disable the workflow** from Settings → Workflows →
  `daily-learn-loop` → toggle. The substrate keeps working from
  whatever inferred file last existed.
- **You can delete `~/.jarvis/learnings/` entirely.** The downstream
  skills handle missing inferred file gracefully — falls back to
  your explicit config alone.
- **You can manually edit** `inferred-priorities.md`. The next run
  rewrites it from scratch (rolling 14d), so your edits get lost
  unless you also update the corresponding explicit config files.
- **Auto-applying inferences** is intentionally NOT a setting.
  When the loop sees enough signal that auto-application would be
  safe, the journal proposes it; you copy into the explicit config
  on your own time. This is the trust boundary.
