# Skill chaining / workflow DAG

## Why

Today every Claude task is a single skill invocation. `ticket-to-pr`
does "plan + create ticket + branch + edit + commit + push" all in one
session. That's fine for tight workflows but breaks down when:

- A skill should fork into multiple parallel sub-tasks (e.g.
  `/review-prs` walking through 5 PRs simultaneously).
- A skill's output should auto-feed the next skill (meeting-debrief →
  action-items extractor → per-item reminder creation).
- A long-running skill should hand off to a fresh context to avoid
  context window pressure.

## What

A skill can spawn another skill mid-execution. The spawned task appears
as a child in the constellation (line connecting parent → child). The
parent can wait for the child's result or fire-and-forget. From the
user's perspective: one prompt → a tree of tasks executing in parallel,
all observable.

## How (rough)

- New SDK tool exposed to skills: `spawn_subtask(skillId, prompt) → {
  taskId, awaitResult?: boolean }`. Implemented in main as a host
  function the SDK marshals.
- TaskSummary already has `groupKey`; extend to `parentTaskId` for
  hierarchy.
- TaskRunner: spawning records the parent-child link, kicks off a
  fresh `query()` with the child's skill. Optionally awaits.
- Constellation: render parent → child as a faded spoke. Click a parent
  to expand its subtree.
- TaskDetail: show "Spawned: task abc12345" inline where the parent
  fired the sub-task.
- Cycle guard: max depth (e.g. 5) so a misbehaving skill can't fork
  bomb.

## Tradeoffs / risks

- **Tool calls vs new SDK invocations.** Anthropic's SDK is moving
  toward "sub-agents as first-class". Wait for that pattern to firm
  up before locking ours in. Alternative: implement as a normal MCP
  tool that the runner intercepts.
- **Context cost.** Parent waiting for child means parent's session is
  open the whole time, billing tokens for the keep-alive. Fire-and-
  forget is cheaper but loses the result handoff.
- **Observability**. Without a good UI, sub-task trees turn into
  spaghetti. The constellation already shows lots; we'd need explicit
  expand/collapse.

## Effort

~1 week. Worth doing once a real use case shows up — currently every
skill we have is single-session.

## Related

- [Action items extractor](./action-items-skill.md) — natural chaining
  candidate (meeting-debrief → action-items → reminders).
- Phase 4 in CLAUDE.md.
