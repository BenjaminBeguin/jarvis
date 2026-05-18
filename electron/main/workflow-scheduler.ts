import cron, { type ScheduledTask } from 'node-cron';

import type { WorkflowDef } from '@shared/types';

import type { WorkflowRunner } from './workflow-runner.js';
import type { WorkflowStore } from './workflow-store.js';

/**
 * Wires workflow triggers to the runner:
 *
 *   - `cron`: registers a `node-cron` job. `trigger.every` accepts
 *     `5m` / `1h` / `2d` shorthand AND full cron strings.
 *   - `manual`: tracked only; the runner is invoked via the IPC
 *     `runWorkflow` channel, the palette intent (`/<workflow-id>`),
 *     or the `run_workflow` Jarvis MCP tool.
 *
 * Maintains an active-jobs map per workflow id so that store changes
 * (file edits, enable/disable, deletion) atomically re-register
 * triggers. Idempotent — calling `syncAll()` after a no-op change
 * leaves the world unchanged.
 *
 * Globally paused (the Jarvis pause flag) cron fires skip — same
 * semantics as RoutineStore: missed fires don't replay. Optional
 * pause-aware predicate is set by index.ts.
 */

interface SchedulerOptions {
  isPaused?: () => boolean;
  /** Returns the current working-hours pref. Used by `{businessHours}`
   *  cron substitution; the seed defaults reference this token so a
   *  single config change updates every workflow that opts in. */
  workingHours?: () => { startHour: number; endHour: number; daysOfWeek: string };
}

interface ActiveJob {
  workflowId: string;
  scheduled: ScheduledTask;
}

const SHORTHAND_RE = /^(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/i;

/**
 * Convert `5m` / `1h` / `2d` to a 5-field cron string. Returns the
 * input unchanged if it already looks like a cron expression.
 *
 *   1s..59s  → rounded up to 1m (node-cron is 5-field by default)
 *   1m..59m  → minute-step cron
 *   1h..23h  → hour-step cron
 *   1d..7d   → day-step cron
 */
/**
 * Substitute the `{businessHours}` token in a cron `every` string
 * with the user's working-hours pref. The token expands to the
 * "<startHour>-<endHour> * * <daysOfWeek>" tail of a 5-field cron,
 * letting seeds write things like `*\/15 {businessHours}` and have
 * the user's hours apply everywhere without rewriting each workflow.
 *
 * Pure substitution — no validation; `expandEvery` validates the
 * final string against node-cron.
 */
function substituteBusinessHours(
  every: string,
  workingHours?: () => { startHour: number; endHour: number; daysOfWeek: string },
): string {
  if (!every.includes('{businessHours}')) return every;
  const wh = workingHours?.() ?? { startHour: 9, endHour: 18, daysOfWeek: '1-5' };
  const tail = `${wh.startHour}-${wh.endHour} * * ${wh.daysOfWeek}`;
  return every.replace(/\{businessHours\}/g, tail);
}

function expandEvery(every: string): string {
  const trimmed = every.trim();
  // Heuristic: cron expressions have 4+ whitespace-separated fields.
  if (trimmed.split(/\s+/).length >= 4) return trimmed;
  const m = SHORTHAND_RE.exec(trimmed);
  if (!m) return trimmed; // pass through; node-cron will throw if invalid
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  if (unit === 's' || unit === 'sec') {
    // No sub-minute cron in node-cron's default mode. Round up to 1m.
    return `*/1 * * * *`;
  }
  if (unit === 'm' || unit === 'min') {
    if (n < 1) return `*/1 * * * *`;
    return `*/${Math.min(n, 59)} * * * *`;
  }
  if (unit === 'h' || unit === 'hr') {
    return `0 */${Math.min(n, 23)} * * *`;
  }
  if (unit === 'd' || unit === 'day') {
    return `0 0 */${Math.min(n, 7)} * *`;
  }
  return trimmed;
}

export class WorkflowScheduler {
  private readonly store: WorkflowStore;
  private readonly runner: WorkflowRunner;
  private readonly isPaused?: () => boolean;
  private readonly workingHours?: () => {
    startHour: number;
    endHour: number;
    daysOfWeek: string;
  };
  private jobs = new Map<string, ActiveJob>();

  constructor(
    store: WorkflowStore,
    runner: WorkflowRunner,
    opts: SchedulerOptions = {},
  ) {
    this.store = store;
    this.runner = runner;
    this.isPaused = opts.isPaused;
    this.workingHours = opts.workingHours;
    this.store.on('changed', () => this.syncAll());
  }

  /**
   * Re-register every cron job. Used when working-hours preferences
   * change — the substituted cron string is different now, so jobs
   * have to be torn down + re-built.
   */
  resync(): void {
    this.syncAll();
  }

  init(): void {
    this.syncAll();
  }

  /**
   * Reconcile active jobs with the current workflow set. Cheap to
   * call — does nothing for workflows whose definition hasn't
   * changed.
   */
  syncAll(): void {
    const all = this.store.list();
    const seen = new Set<string>();
    for (const def of all) {
      seen.add(def.id);
      this.applyOne(def);
    }
    // Anything removed from the store loses its job.
    for (const [id, job] of this.jobs) {
      if (!seen.has(id)) {
        job.scheduled.stop();
        this.jobs.delete(id);
      }
    }
  }

  /** Fire a workflow manually (palette button, "Run now" UI). */
  runManually(id: string): void {
    const def = this.store.get(id);
    if (!def) throw new Error(`Workflow not found: ${id}`);
    this.runner.run(def, 'manual');
  }

  /** Stop every cron job. Called on app shutdown. */
  close(): void {
    for (const job of this.jobs.values()) job.scheduled.stop();
    this.jobs.clear();
  }

  private applyOne(def: WorkflowDef): void {
    const existing = this.jobs.get(def.id);
    // Tear down stale job — definition or enabled state may have flipped.
    if (existing) {
      existing.scheduled.stop();
      this.jobs.delete(def.id);
    }
    if (!def.enabled) return;
    if (def.trigger.kind !== 'cron') return; // manual not scheduled here
    // Resolve {businessHours} → "<start>-<end> * * <days>" first, so
    // expandEvery sees the final string. Workflows that don't use the
    // token are unaffected (string.replace is a no-op).
    const resolved = substituteBusinessHours(
      def.trigger.every,
      this.workingHours,
    );
    const cronExpr = expandEvery(resolved);
    if (!cron.validate(cronExpr)) {
      console.warn(
        `[workflow-scheduler] invalid cron for ${def.id}: "${def.trigger.every}" → "${cronExpr}"`,
      );
      return;
    }
    const scheduled = cron.schedule(cronExpr, () => {
      if (this.isPaused?.()) {
        console.log(`[workflow-scheduler] ${def.id} paused — skipping fire`);
        return;
      }
      // Re-fetch the latest def on each tick so an edit between
      // creation and fire takes effect.
      const fresh = this.store.get(def.id);
      if (!fresh || !fresh.enabled) return;
      try {
        this.runner.run(fresh, 'cron');
      } catch (err) {
        console.warn(`[workflow-scheduler] ${def.id} fire failed:`, err);
      }
    });
    this.jobs.set(def.id, { workflowId: def.id, scheduled });
  }
}
