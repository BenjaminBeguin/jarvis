# Action items extractor — dedicated skill

## Why

`meeting-debrief` (shipped) restructures a transcript into Summary /
Decisions / Action items / Open questions. But action items are
text-only — they don't become reminders, don't get assigned, don't
flow into Linear. They're a section in a markdown file.

The user has explicitly asked: "during a meeting I see something to
improve — turn it into a Linear ticket + draft PR". `ticket-to-pr`
covers the live-meeting selection flow. But for the **post-meeting**
flow ("here are all the action items from this meeting, do something
with each"), there's no dedicated path.

## What

A skill `action-items` that takes a meeting transcript (or any chunk
of conversation) and returns a structured list of action items:

```json
[
  { "owner": "@me", "what": "follow up with Luca on PR 450", "by": "tomorrow" },
  { "owner": "@me", "what": "draft the Q3 deck", "by": null },
  { "owner": "@alex", "what": "investigate the cart flicker bug", "by": "this week" }
]
```

Then, for each item where `owner === '@me'`:
- Offer to create a reminder (`by` → fireAt).
- Or offer to create a Linear ticket via the existing
  `ticket-to-pr` skill.
- User confirms per item or applies-to-all.

## How (rough)

- New seeded skill `action-items` with `allowed-tools: [Read,
  mcp__linear__*]` and a strict prompt that returns JSON-only output
  to `~/.jarvis/.action-items-batch.json`.
- A new module `action-items-extractor` exposes
  `/extract-actions [meeting-path]` palette intent.
- On batch ingest (similar pattern to skill-suggester), the action
  items appear in a Dashboard panel "Action items from <meeting>"
  with per-row Accept (→ reminder or ticket) / Dismiss.

## Tradeoffs / risks

- **Owner attribution**. Whisper transcripts don't have speaker
  diarization. Claude has to infer "I'll do X" vs "you'll do X" from
  context. Wrong attribution = bad UX.
- **Double-work with meeting-debrief**. The debrief skill ALSO
  extracts action items (as a markdown section). Either:
  - Have debrief write structured JSON in parallel, and skip the
    standalone extractor.
  - Or call action-items as a sub-task from debrief.
  The latter is cleaner once skill chaining ships
  ([skill-chaining.md](./skill-chaining.md)).

## Effort

~2 sessions for the skill + extractor module + dashboard panel.

## Related

- [Skill chaining](./skill-chaining.md) — best implementation needs it.
- meeting-debrief (shipped) — currently does this informally.
