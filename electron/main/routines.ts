import { exec } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import cron, { type ScheduledTask } from 'node-cron';
import { nanoid } from 'nanoid';

import type { RoutineDef } from '@shared/types';
import type { TaskRunner } from './task-runner.js';

const execAsync = promisify(exec);

interface PersistedRoutine {
  id: string;
  skillId: string;
  workspaceId?: string;
  cron: string;
  input?: string;
  enabled?: boolean;
  lastRunAt?: number;
  condition?: string;
  lastTaskId?: string;
  recentTaskIds?: string[];
  showInCalendar?: boolean;
  /** Default true. Persisted only when explicitly set to false so most
   *  routines.json entries stay compact. */
  unattended?: boolean;
}

/** How many historical run task ids to keep per routine. Enough to render
 * a "last week's runs" history without bloating routines.json. */
const RECENT_TASK_IDS_MAX = 20;

interface ScheduledRoutine {
  def: RoutineDef;
  task: ScheduledTask | null;
}

function isPersistedRoutine(v: unknown): v is PersistedRoutine {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string'
    && typeof r.skillId === 'string'
    && typeof r.cron === 'string';
}

export class RoutineStore extends EventEmitter {
  private routines = new Map<string, ScheduledRoutine>();
  readonly path: string;
  private runner: TaskRunner | null = null;
  /** Optional predicate: when present and returns true, fire() bails
   *  silently. Set by index.ts to honor the global pause flag. */
  private isPaused: (() => boolean) | null = null;
  /** Workspace gate. Returns true iff a routine tagged with this
   *  workspaceId should fire right now (workspaceId === active OR
   *  workspaceId == null). Routines tagged to another workspace are
   *  silenced. Set by index.ts via setWorkspaceGate. */
  private isWorkspaceActive:
    | ((workspaceId: string | null | undefined) => boolean)
    | null = null;

  constructor(path = join(homedir(), '.jarvis', 'routines.json')) {
    super();
    this.path = path;
  }

  setPausePredicate(fn: () => boolean): void {
    this.isPaused = fn;
  }

  setWorkspaceGate(
    fn: (workspaceId: string | null | undefined) => boolean,
  ): void {
    this.isWorkspaceActive = fn;
  }

  setRunner(runner: TaskRunner): void {
    this.runner = runner;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.load();
  }

  list(): RoutineDef[] {
    return [...this.routines.values()]
      .map((r) => r.def)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  save(input: Partial<RoutineDef> & { skillId: string; cron: string }): RoutineDef {
    if (input.cron && !cron.validate(input.cron)) {
      throw new Error(`Invalid cron expression: ${input.cron}`);
    }
    const id = input.id ?? nanoid(8);
    const existing = this.routines.get(id);
    const def: RoutineDef = {
      id,
      skillId: input.skillId,
      // Workspace stamping. Honor an explicit input.workspaceId
      // (including `null`/undefined to mark global). For NEW routines
      // with nothing specified, fall through to the existing
      // workspaceId or undefined; the IPC layer stamps the active
      // workspace at creation time so routines created from the
      // Routines UI auto-belong to the current context.
      workspaceId:
        input.workspaceId !== undefined
          ? input.workspaceId
          : existing?.def.workspaceId,
      cron: input.cron,
      input: input.input ?? '',
      enabled: input.enabled ?? existing?.def.enabled ?? true,
      lastRunAt: existing?.def.lastRunAt ?? null,
      nextRunAt: null,
      condition: input.condition ?? existing?.def.condition,
      lastTaskId: existing?.def.lastTaskId ?? null,
      recentTaskIds: existing?.def.recentTaskIds ?? [],
      showInCalendar:
        input.showInCalendar ?? existing?.def.showInCalendar ?? true,
      unattended: input.unattended ?? existing?.def.unattended ?? true,
    };
    this.applyRoutine(def);
    this.persist();
    this.emit('changed', this.list());
    return def;
  }

  remove(id: string): boolean {
    const rec = this.routines.get(id);
    if (!rec) return false;
    rec.task?.stop();
    this.routines.delete(id);
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  runNow(id: string): boolean {
    const rec = this.routines.get(id);
    if (!rec || !this.runner) return false;
    this.fire(rec.def);
    return true;
  }

  /**
   * Flip a routine's `enabled` flag — disables the cron schedule
   * without dropping the routine definition itself. Returns the
   * updated routine, or null if the id is unknown. Used by the MCP
   * `set_routine_enabled` tool; the Routines UI uses save() with a
   * full input instead.
   */
  setEnabled(id: string, enabled: boolean): RoutineDef | null {
    const rec = this.routines.get(id);
    if (!rec) return null;
    if (rec.def.enabled === enabled) return rec.def;
    return this.save({ ...rec.def, enabled });
  }

  close(): void {
    for (const rec of this.routines.values()) rec.task?.stop();
    this.routines.clear();
  }

  private applyRoutine(def: RoutineDef): void {
    const existing = this.routines.get(def.id);
    if (existing) existing.task?.stop();
    const task = def.enabled
      ? cron.schedule(def.cron, () => void this.tick(def.id), {
          scheduled: true,
        })
      : null;
    this.routines.set(def.id, { def, task });
  }

  /**
   * Cron-tick entry point. Reads the latest def from the map (so the
   * condition + skill reflect any in-flight edits), then either fires
   * directly or runs the condition gate first.
   */
  private async tick(id: string): Promise<void> {
    const rec = this.routines.get(id);
    if (!rec) return;
    const def = rec.def;
    if (!def.condition) {
      this.fire(def);
      return;
    }
    // Watch flavor: cheap shell command decides whether to fire. Empty
    // stdout (or non-zero exit) = skip this tick. Trimmed to ignore
    // trailing newlines.
    let fired: 'fired' | 'skipped' | 'errored' = 'skipped';
    try {
      const { stdout } = await execAsync(def.condition, {
        timeout: 30_000,
        env: process.env,
      });
      if (stdout.trim().length > 0) {
        this.fire(def);
        fired = 'fired';
      }
    } catch (err) {
      console.warn(`routine ${id}: condition errored:`, err);
      fired = 'errored';
    }
    const updated: RoutineDef = {
      ...def,
      lastConditionAt: Date.now(),
      lastConditionResult: fired,
    };
    rec.def = updated;
    // We only persist after fire() (which calls persist itself) — for
    // skip/error we keep state in-memory to avoid hammering disk every
    // 5 minutes. lastConditionResult is informational, not critical.
    this.emit('changed', this.list());
  }

  private fire(def: RoutineDef): void {
    if (!this.runner) return;
    // Global pause: skip cron-fired turns entirely. The cron tick
    // resumes naturally when the user un-pauses; missed fires are
    // not re-played (a daily routine that missed today doesn't run
    // twice tomorrow). The store-level isPaused predicate is set
    // by index.ts on the config 'paused' field.
    if (this.isPaused?.()) {
      console.log(`[routine ${def.id}] paused — skipping fire`);
      return;
    }
    // Workspace gate. A routine pinned to "Work" workspace shouldn't
    // fire its cron while the user is in "Personal" — that's the
    // whole point of workspace contexts. Null workspaceId = legacy /
    // global, always fires.
    if (this.isWorkspaceActive && !this.isWorkspaceActive(def.workspaceId)) {
      console.log(
        `[routine ${def.id}] workspace mismatch (def="${def.workspaceId ?? 'global'}") — skipping fire`,
      );
      return;
    }
    const task = this.runner.launch({
      skillId: def.skillId,
      prompt: def.input || 'Run.',
      origin: 'routine',
      routineId: def.id,
      // Cron fires are unattended by default. If the agent ends with
      // a question the task is flagged errored so the routine shows in
      // the "Needs attention" inbox source. Set on the def to false to
      // allow questions (rare).
      unattended: def.unattended !== false,
    });
    // Prepend the new task id to the history, dedup just in case, cap at
    // RECENT_TASK_IDS_MAX so routines.json doesn't grow unbounded.
    const priorRecents = def.recentTaskIds ?? [];
    const recentTaskIds = [
      task.id,
      ...priorRecents.filter((id) => id !== task.id),
    ].slice(0, RECENT_TASK_IDS_MAX);
    const updated: RoutineDef = {
      ...def,
      lastRunAt: Date.now(),
      lastConditionAt: def.condition ? Date.now() : def.lastConditionAt,
      lastConditionResult: def.condition ? 'fired' : def.lastConditionResult,
      lastTaskId: task.id,
      recentTaskIds,
    };
    const rec = this.routines.get(def.id);
    if (rec) rec.def = updated;
    this.persist();
    this.emit('changed', this.list());
  }

  private load(): void {
    this.routines.clear();
    if (!existsSync(this.path)) {
      this.emit('changed', []);
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      const list = Array.isArray(raw) ? raw : [];
      for (const item of list) {
        if (!isPersistedRoutine(item)) continue;
        if (!cron.validate(item.cron)) {
          console.warn(`skipping routine ${item.id}: invalid cron "${item.cron}"`);
          continue;
        }
        const def: RoutineDef = {
          id: item.id,
          skillId: item.skillId,
          workspaceId: item.workspaceId,
          cron: item.cron,
          input: item.input ?? '',
          enabled: item.enabled ?? true,
          lastRunAt: item.lastRunAt ?? null,
          nextRunAt: null,
          condition: item.condition,
          lastTaskId: item.lastTaskId ?? null,
          recentTaskIds: Array.isArray(item.recentTaskIds)
            ? item.recentTaskIds.filter((s) => typeof s === 'string')
            : item.lastTaskId
              ? [item.lastTaskId]
              : [],
          showInCalendar: item.showInCalendar ?? true,
          unattended: item.unattended ?? true,
        };
        this.applyRoutine(def);
      }
    } catch (err) {
      console.warn(`failed to load routines.json:`, err);
    }
    this.emit('changed', this.list());
  }

  private persist(): void {
    const list: PersistedRoutine[] = [...this.routines.values()].map((r) => ({
      id: r.def.id,
      skillId: r.def.skillId,
      workspaceId: r.def.workspaceId,
      cron: r.def.cron,
      input: r.def.input,
      enabled: r.def.enabled,
      lastRunAt: r.def.lastRunAt ?? undefined,
      condition: r.def.condition,
      lastTaskId: r.def.lastTaskId ?? undefined,
      recentTaskIds: r.def.recentTaskIds?.length
        ? r.def.recentTaskIds
        : undefined,
      // Only persist the flag when it's the non-default (false) — keeps
      // routines.json small for the common case (visible).
      showInCalendar: r.def.showInCalendar === false ? false : undefined,
      // Same pattern: unattended defaults true, persist only when the
      // user opted into the rare attended-routine case.
      unattended: r.def.unattended === false ? false : undefined,
    }));
    writeFileSync(this.path, JSON.stringify(list, null, 2), 'utf8');
  }
}
