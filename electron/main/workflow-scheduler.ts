import cron, { type ScheduledTask } from 'node-cron';

import type { WorkflowDef } from '@shared/types';

import { isOverdue } from './cron-matcher.js';
import { getLastWorkflowRunStartedAt } from './db.js';
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
  /** True when appMode === 'autopilot'. Gates the new autopilot
   *  trigger kind — workflows with `trigger.kind === 'autopilot'`
   *  only fire when this returns true. Inbox-changed-triggered ones
   *  are dispatched by the InboxEventBridge instead of cron, so
   *  they skip the cron path entirely. */
  isAutopilot?: () => boolean;
  /** Returns the current working-hours pref. Used by `{businessHours}`
   *  cron substitution; the seed defaults reference this token so a
   *  single config change updates every workflow that opts in. */
  workingHours?: () => { startHour: number; endHour: number; daysOfWeek: string };
  /** Workspace gate. Returns true iff a workflow tagged with this
   *  workspaceId should fire right now (workspaceId === active OR
   *  workspaceId == null). Workflows tagged to another workspace are
   *  silenced until the user switches contexts. See workspace-gate.ts. */
  isWorkspaceActive?: (workspaceId: string | null | undefined) => boolean;
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
  private readonly isAutopilot?: () => boolean;
  private readonly workingHours?: () => {
    startHour: number;
    endHour: number;
    daysOfWeek: string;
  };
  private readonly isWorkspaceActive?: (
    workspaceId: string | null | undefined,
  ) => boolean;
  private jobs = new Map<string, ActiveJob>();

  constructor(
    store: WorkflowStore,
    runner: WorkflowRunner,
    opts: SchedulerOptions = {},
  ) {
    this.store = store;
    this.runner = runner;
    this.isPaused = opts.isPaused;
    this.isAutopilot = opts.isAutopilot;
    this.workingHours = opts.workingHours;
    this.isWorkspaceActive = opts.isWorkspaceActive;
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
    // Catch-up pass: when the app starts (or after `pnpm dev` reload),
    // some cron workflows may have missed their scheduled fires while
    // the app was closed. Fire each one once if its last run is
    // overdue relative to its cron expression. Single-shot — not a
    // replay of every missed fire. Delayed slightly so the rest of
    // boot (auth refresh, MCP load, etc.) settles first.
    setTimeout(() => this.catchUpOverdue(), 5_000);
  }

  /**
   * For each enabled cron / autopilot-cron workflow, check whether
   * its cron expression should have fired between the last persisted
   * run and now. If yes — fire it once. Skipped when globally paused
   * or when the autopilot gate isn't open (matches the normal cron
   * tick's gating).
   */
  private catchUpOverdue(): void {
    if (this.isPaused?.()) return;
    const now = Date.now();
    for (const def of this.store.list()) {
      if (!def.enabled) continue;
      let every: string | undefined;
      let isAutopilotTrigger = false;
      if (def.trigger.kind === 'cron') {
        every = def.trigger.every;
      } else if (def.trigger.kind === 'autopilot') {
        isAutopilotTrigger = true;
        if (def.trigger.when !== 'cron') continue;
        every = def.trigger.every;
      } else {
        continue;
      }
      if (!every) continue;
      if (isAutopilotTrigger && !this.isAutopilot?.()) continue;
      // Same workspace gate as the live cron path — don't catch up
      // workflows that belong to a workspace we're not currently in.
      // Otherwise opening Jarvis in "Personal" would replay all the
      // overdue "Work" workflows that should stay silent.
      if (this.isWorkspaceActive && !this.isWorkspaceActive(def.workspaceId)) {
        continue;
      }
      const resolved = substituteBusinessHours(every, this.workingHours);
      const cronExpr = expandEvery(resolved);
      if (!cron.validate(cronExpr)) continue;
      const lastRunAt = getLastWorkflowRunStartedAt(def.id);
      if (!isOverdue(cronExpr, lastRunAt, now)) continue;
      console.info(
        `[workflow-scheduler] ${def.id} overdue (last run ${
          lastRunAt ? new Date(lastRunAt).toISOString() : 'never'
        }) — firing catch-up`,
      );
      try {
        this.runner.run(def, isAutopilotTrigger ? 'autopilot' : 'cron');
      } catch (err) {
        console.warn(
          `[workflow-scheduler] ${def.id} catch-up fire failed:`,
          err,
        );
      }
    }
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
    // Extract the cron `every` string this trigger needs scheduling
    // for — cron triggers always; autopilot triggers only when
    // `when === 'cron'`. inbox-changed-triggered ones don't schedule
    // here at all (InboxEventBridge dispatches them).
    let every: string | null = null;
    if (def.trigger.kind === 'cron') {
      every = def.trigger.every;
    } else if (def.trigger.kind === 'autopilot') {
      if (def.trigger.when !== 'cron') return;
      if (!def.trigger.every) {
        console.warn(
          `[workflow-scheduler] ${def.id} autopilot/cron trigger missing 'every' — skipping`,
        );
        return;
      }
      every = def.trigger.every;
    } else {
      // 'manual' — runs via "Run now", palette, or MCP tool.
      return;
    }
    const resolved = substituteBusinessHours(every, this.workingHours);
    const cronExpr = expandEvery(resolved);
    if (!cron.validate(cronExpr)) {
      console.warn(
        `[workflow-scheduler] invalid cron for ${def.id}: "${every}" → "${cronExpr}"`,
      );
      return;
    }
    const isAutopilotTrigger = def.trigger.kind === 'autopilot';
    const scheduled = cron.schedule(cronExpr, () => {
      if (this.isPaused?.()) {
        console.log(`[workflow-scheduler] ${def.id} paused — skipping fire`);
        return;
      }
      if (isAutopilotTrigger && !this.isAutopilot?.()) {
        // Trigger only fires when the app is in autopilot mode.
        return;
      }
      // Re-fetch the latest def on each tick so an edit between
      // creation and fire takes effect.
      const fresh = this.store.get(def.id);
      if (!fresh || !fresh.enabled) return;
      // Workspace gate: cron-driven fires only happen when the
      // workflow's workspaceId matches the active workspace (or is
      // null = global). Lets users keep "work autopilot" workflows
      // silent while they're in "Side Project" mode without disabling
      // them. Manual runs (palette / "Run now" UI / mcp__run_workflow)
      // bypass this — those are explicit user actions.
      if (
        this.isWorkspaceActive &&
        !this.isWorkspaceActive(fresh.workspaceId)
      ) {
        console.log(
          `[workflow-scheduler] ${fresh.id} skipped — workspace mismatch (def="${fresh.workspaceId ?? 'global'}")`,
        );
        return;
      }
      try {
        this.runner.run(fresh, isAutopilotTrigger ? 'autopilot' : 'cron');
      } catch (err) {
        console.warn(`[workflow-scheduler] ${def.id} fire failed:`, err);
      }
    });
    this.jobs.set(def.id, { workflowId: def.id, scheduled });
  }
}
