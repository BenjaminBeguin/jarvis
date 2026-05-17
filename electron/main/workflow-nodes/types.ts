import type { fromPromise } from 'xstate';

import type { InboxStore } from '../inbox.js';
import type { McpConfigStore } from '../mcp-config.js';
import type { notifier as Notifier } from '../notifier.js';
import type { TaskRunner } from '../task-runner.js';

/**
 * What every node handler receives. Read-only — handlers may use
 * `ctx.inbox.upsertSourceItems(...)` etc., but shouldn't mutate
 * `ctx` directly.
 */
export interface WorkflowNodeContext {
  /** Tokens read from `~/.jarvis/mcp.json` via `auth.mcp` in params. */
  mcp: McpConfigStore;
  /** Inbox-write node target. */
  inbox: InboxStore;
  /** Notify node target. */
  notifier: typeof Notifier;
  /** Run-skill node uses this to spawn a Claude turn. */
  runner: TaskRunner;
  /** Used by `osascript` / `shell` and any node that writes to disk. */
  jarvisRoot: string;
}

/**
 * Input shape passed to a node handler's `fromPromise` actor logic.
 *
 *   - `params`: the static config from the workflow JSON.
 *   - `prev`:   the previous node's output (undefined for the first step).
 *   - `ctx`:    shared services (see above).
 *   - `signal`: cancellation; XState forwards this when the actor is
 *               stopped (e.g. user clicks Stop on a running workflow).
 */
export interface NodeHandlerInput<P = Record<string, unknown>> {
  params: P;
  prev: unknown;
  ctx: WorkflowNodeContext;
  signal: AbortSignal;
}

/** Each node handler is just a `fromPromise` actor that takes the
 *  shared input shape and returns the next step's input. Keeping the
 *  registry typed as `fromPromise` lets XState's invoke wire up
 *  naturally — no wrappers, no glue. */
export type NodeHandler<P = Record<string, unknown>> = ReturnType<
  typeof fromPromise<unknown, NodeHandlerInput<P>>
>;
