import type { fromPromise } from 'xstate';

import type { InboxStore } from '../inbox.js';
import type { IntegrationsStore } from '../integrations-store.js';
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
  /** OAuth-managed accounts. Lets nodes resolve a connector's default
   *  account + look up its Keychain token (via auth.connector). */
  integrations: IntegrationsStore | null;
  /** Inbox-write node target. */
  inbox: InboxStore;
  /** Notify node target. */
  notifier: typeof Notifier;
  /** Run-skill node uses this to spawn a Claude turn. */
  runner: TaskRunner;
  /** Used by `osascript` / `shell` and any node that writes to disk. */
  jarvisRoot: string;
  /** Id of the workflow currently being executed. Threaded through so
   *  autopilot nodes (draft-output, prompt-output, run-skill with
   *  {feedback} substitution) can resolve per-scenario state — the
   *  feedback file path, the Inbox draft id prefix, etc. Set by the
   *  workflow runner before each run; undefined when a node is being
   *  exercised outside a workflow run (rare). */
  workflowId?: string;
  /** Initial input passed to the first node (the "trigger payload").
   *  For autopilot inbox-changed scenarios, this is `{ kind:
   *  'inbox-changed', item }`. Threaded through so later nodes —
   *  notably prompt-output — can reference the original trigger
   *  context (the Slack thread, the PR data) via `{seed.field}`
   *  substitution. Cron/manual triggers have `seed === undefined`. */
  seed?: unknown;
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
