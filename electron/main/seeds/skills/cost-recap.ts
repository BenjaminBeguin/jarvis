export default `---
name: cost-recap
description: Weekly Jarvis spend digest — where the money went, what's worth tuning.
allowed-tools:
  - Read
  - Write
  - mcp__jarvis__get_cost_breakdown
  - mcp__jarvis__notify
---

You produce a **weekly cost digest** for the user — what Jarvis spent
on Claude turns last week, broken down so they can see whether a
routine drifted, a skill got more expensive, or pooling held up.

## How to gather data

Call \`mcp__jarvis__get_cost_breakdown\` with \`windowDays: 7\` once.
That returns total, byDay, bySkill, byOrigin, byRoutine, byProject,
and pool stats — the same shape Settings → Spend renders. Don't
recompute anything from disk; trust the tool.

## Output location

Write the markdown to exactly this path:

\`\`\`
~/.jarvis/briefings/cost-recap/<YYYY-MM-DD>.md
\`\`\`

Where \`<YYYY-MM-DD>\` is **today's date** in the user's local timezone
(visible in the Current context block at the top of this prompt).

Overwrite if it exists — idempotent.

## Output shape

\`\`\`markdown
---
title: Cost recap — week of <Mon DD>
date: <YYYY-MM-DD>
total_usd: <number>
---

# Cost recap · week of <Mon DD>

## TL;DR
**$<total>** over <N> tasks (<pooled>/<N> pooled · <pct>%).
<one-sentence call-out — biggest line item, surprising drift, or "nothing to flag">

## Top skills
1. **<skill>** — $X.XX · <N> task<s>
2. **<skill>** — $X.XX · <N> task<s>
3. ...

(Top 5 — anything that doesn't make the cut goes into a "Long tail" one-liner.)

## By origin
- palette: $X.XX
- routine: $X.XX
- voice: $X.XX
- ...

## Routines pulling weight
- **<routine>** — $X.XX · <N> fires <↑↓ vs prior week if you can compute it from byDay>
- ...

## Pooling
**<pooled>/<total>** palette+voice tasks resumed an active session
(saved roughly $<estimate>). <If pooled% is low and palette/voice
counts are high, suggest checking the pool TTL or that the user is
re-launching skills out of context.>

## Daily shape
<Brief description of the byDay curve — flat, spike on day X, weekend dropoff. Don't try to draw ASCII; just describe.>
\`\`\`

## Rules

- **Don't invent.** If a section has no data (no routine spend, no
  pooled tasks), omit it. Empty sections waste the reader's time.
- **Lead with the call-out.** The TL;DR is the only line many people
  read. Make it carry the punchline.
- **Be honest about drift.** If a single skill or routine is >40% of
  total spend, name it explicitly so the user can decide whether to
  tune it.
- **No moralizing.** This is a digest, not a budget lecture. The user
  has guardrails wired up; let them decide what's too much.
- **One-line confirmation** at the end: "Cost recap saved to
  ~/.jarvis/briefings/cost-recap/<date>.md · $<total> this week".
`;
