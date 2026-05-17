# Workflows — JSON-defined pipelines

A **Workflow** is one trigger + a linear list of nodes. Each node is a
small piece of code (`http-fetch`, `transform`, `osascript`, `shell`,
`inbox-write`, `notify`, `run-skill`) that takes the previous step's
output and emits its own. The user-facing definition is flat JSON; at
load time we compile each workflow into an [XState v5](https://xstate.js.org/)
machine so cancellation, retries, and error boundaries come for free.

Lives in [electron/main/workflow-store.ts](../electron/main/workflow-store.ts),
runs in [electron/main/workflow-runner.ts](../electron/main/workflow-runner.ts),
nodes in [electron/main/workflow-nodes/](../electron/main/workflow-nodes/).
JSON files persist under `~/.jarvis/workflows/<id>.json` and the
chokidar watcher picks up external edits.

## Mental model

```
trigger → node[0] → node[1] → … → node[N]
```

A workflow either schedules itself (`cron`) or is fired by the user
(`manual` — palette, MCP tool, "Run now" button). Each node receives
the previous node's output as `prev`; emits the value it returned;
errors short-circuit the pipeline to a terminal `errored` state.

### File shape

```json
{
  "id": "linear-inbox-sync",
  "name": "Sync Linear inbox",
  "description": "Pull assigned-and-open issues from Linear every 5 min.",
  "enabled": true,
  "trigger": { "kind": "cron", "every": "5m" },
  "pipeline": [
    {
      "type": "http-fetch",
      "params": {
        "url": "https://api.linear.app/graphql",
        "method": "POST",
        "auth": { "mcp": "linear", "var": "LINEAR_API_TOKEN" },
        "body": { "query": "..." }
      }
    },
    { "type": "transform",   "params": { "fn": "($.data.issues.nodes ?? []).map(n => …)" } },
    { "type": "inbox-write", "params": { "source": "linear", "label": "Linear · needs you" } }
  ]
}
```

The built-in workflows live under
[electron/main/seeds/workflows/](../electron/main/seeds/workflows/) and
are written to `~/.jarvis/workflows/` on first launch if missing —
user edits are never overwritten.

## Triggers

V1 supports two trigger kinds. Event-driven triggers will land once we
have a clear use case; adding the wire shape now would force decisions
we don't need to make yet.

### `cron`

```json
{ "kind": "cron", "every": "5m" }
```

`every` accepts shorthand (`5m`, `1h`, `2d`) and full 5-field cron
strings (`0 9 * * 1-5`). Globally-paused workflows skip fires — same
semantics as `RoutineStore`. Missed fires don't replay.

### `manual`

```json
{ "kind": "manual", "palette": "linear-sync" }
```

Not scheduled. Fires via:

- The **palette**: `/wf <workflow-id>` (or `/wf` with no args lists every workflow).
- The **Jarvis MCP** server: `mcp__jarvis__run_workflow({ id })` from inside any task.
- The Workflows tab's **Run now** button.
- The `runWorkflow` IPC channel (used by the UI; available to any
  module via `ctx.runWorkflow(id)`).

`palette` is optional metadata — currently unused, reserved for
auto-registering one-prefix-per-workflow palette intents later.

## Node catalogue

Every node is a [`fromPromise`](https://stately.ai/docs/actors-from-promise)
XState actor. XState forwards an `AbortSignal` into each one so a
`stop()` on the run propagates into in-flight `fetch` / child processes
without any thread-the-signal-manually plumbing.

| type | What it does | Output |
|---|---|---|
| `http-fetch` | HTTP request. `auth.scheme` = `'raw'` (default, Linear-style) or `'bearer'` (Slack). `bodyEncoding` = `'json'` (default) or `'form'`. | Parsed JSON body (or text). |
| `osascript` | macOS-only AppleScript via `osascript -e`. | stdout, trimmed. |
| `shell` | Arbitrary command via `execFile`. | stdout, trimmed. |
| `transform` | JS expression body. `$` is `prev`. Sandbox: `new Function('$', \`return (${fn})\`)`. No globals, no imports. | Whatever `fn($)` returns. |
| `inbox-write` | Writes `InboxItem[]` to the Inbox under a named source. Always the last node in inbox-feeding workflows. | Pass-through of items. |
| `notify` | OS notification via the Jarvis notifier. | `prev` pass-through. |
| `run-skill` | Launches a skill task and awaits the first SDK result. Bridges into agentic work. | Final assistant text. |

Adding a node type: drop a file under
[electron/main/workflow-nodes/](../electron/main/workflow-nodes/)
exporting a `fromPromise` actor, register it in
[index.ts](../electron/main/workflow-nodes/index.ts), and add the
type literal to `WorkflowNodeType` in
[src/shared/types.ts](../src/shared/types.ts).

## Visualization

The Workflows tab renders each workflow as a graph using
[@xyflow/react](https://reactflow.dev/) — trigger node on the left,
one node per pipeline step, animated edges. Edges turn green when both
endpoints completed, animate cyan during a live step, go red after an
errored step.

Click a node to inspect it: the Step tab in the bottom dock shows the
node's **configuration** (URL/method/auth for http-fetch, the JS body
for transform, etc.) AND the **output** that step produced on the most
recent run. Outputs are capped at 100KB to keep run history bounded.

Future-clickable / draggable / connectable handles are React Flow
primitives — currently disabled but one prop flip away once the
JSON-only authoring story needs a graphical step up.

## Inbox integration

A workflow whose pipeline ends in `inbox-write` is functionally an
inbox source: the runner calls
`InboxStore.setExternalItems(source, label, items)` which auto-registers
a trivial `InboxSource`. The workflow's cron drives refresh; the Inbox
tab's "Refresh" button just re-reads cache.

Linear, Slack, and Calendar inbox feeds are all workflows
(`linear-inbox-sync.json`, `slack-inbox-sync.json`,
`calendar-today-sync.json`). The old TS-based sources are deleted —
the workflows are the canonical implementation.

## Access surfaces

Each surface lands in the same place: `workflowRunner.run(def, 'manual')`.

| Surface | How |
|---|---|
| **Palette** | `/wf <id>` via the [workflows module](../electron/main/modules/workflows.ts). Typing `/wf` with no arg lists every workflow. |
| **Internal MCP** | `mcp__jarvis__list_workflows` + `mcp__jarvis__run_workflow({ id })` (see [jarvis-mcp.ts](../electron/main/jarvis-mcp.ts)). Any task can fire any workflow. |
| **UI** | "Run now" button on the Workflows page. |
| **Cron** | Auto-scheduled by [workflow-scheduler.ts](../electron/main/workflow-scheduler.ts) when `trigger.kind === 'cron'`. |
| **Module** | `ctx.runWorkflow(id)` for any module (the Telegram bot could add `/workflow` mirrors here). |

Every fire records a `workflow.run` activity entry with the surface
and run id, so the Activity tab shows where each invocation came from.

## Gotchas

- **The transform sandbox is real but not airtight.** It's
  `new Function('$', \`return (${fn})\`)` — no globals, no imports, but
  not isolated from the Node runtime. Personal-tool threat model: the
  JSON is on the user's disk and they wrote it. Community-authored
  workflows would need a real sandbox (`vm2` / `isolated-vm` / QuickJS).
- **Run history is in-memory.** Caps at 60 runs; older runs drop.
  SQLite persistence is a v1.5 follow-up. XState snapshots make this
  clean when we get there.
- **Outputs over 100KB are truncated** before being stored on the
  run record. The inspector flags truncated steps inline.
- **No branching / parallel.** Linear pipelines only in V1 — XState
  supports parallel regions natively when we want them; not yet
  exposed in the user-facing JSON.
