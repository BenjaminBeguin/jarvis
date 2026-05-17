/**
 * Shared types for the FlowStream live event page.
 *
 * The FlowStream view merges several existing IPC channels (taskStatus,
 * remindersChanged, inboxRefreshing, notifierEmitted) into one unified
 * timeline of `FlowEvent` records, each placed on a stage in the
 * processing pipeline. The page is intentionally ephemeral — events
 * fade out after a grace window; persistent history lives elsewhere
 * (AI Agent tab, Activity, SQLite).
 */

/**
 * Stages an event passes through, left-to-right on the river. Not every
 * event hits every stage — a verbal-intent match resolves at `route`
 * without ever reaching `launch`; a notifier-only fire enters straight
 * at `notify`; an inbox-scan stops at `agent` (it IS the agent).
 */
export type Stage =
  | 'trigger'
  | 'intent'
  | 'route'
  | 'launch'
  | 'agent'
  | 'result'
  | 'notify';

export const STAGES: Stage[] = [
  'trigger',
  'intent',
  'route',
  'launch',
  'agent',
  'result',
  'notify',
];

/** Where this event originated — color-codes the orb. */
export type FlowSource =
  | 'palette'
  | 'voice'
  | 'cron'
  | 'reminder'
  | 'telegram'
  | 'module'
  | 'notifier'
  | 'unknown';

/** What kind of underlying entity the orb represents — drives the
 *  click-through navigation and the tooltip's "open in …" target. */
export type FlowKind = 'task' | 'reminder' | 'inbox-scan' | 'notification';

export interface FlowEvent {
  /** Stable id for the lifetime of this orb on screen. Derived from
   *  `${kind}:${entityId}` so repeated updates to the same task /
   *  reminder land on the same orb (we advance its stage rather than
   *  spawn a new one). */
  id: string;
  source: FlowSource;
  kind: FlowKind;
  /** Task id / reminder id / inbox source name / notification id.
   *  Used for the click-through target. */
  entityId: string;
  /** Short label (~60 chars). What the user reads on hover. */
  label: string;
  stage: Stage;
  stageHistory: Array<{ stage: Stage; ts: number }>;
  status: 'in-flight' | 'completed' | 'errored' | 'aborted';
  enteredAt: number;
  /** When the orb should drift off-screen. Set once stage hits a
   *  terminal value (`result` or `notify`). null while in-flight. */
  fadeAt: number | null;
  /** Stable 0-1 vertical jitter so the orb has a consistent Y across
   *  re-renders. Computed once on insert. */
  jitter: number;
}
