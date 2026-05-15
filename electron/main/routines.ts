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
  cron: string;
  input?: string;
  enabled?: boolean;
  lastRunAt?: number;
  condition?: string;
  lastTaskId?: string;
}

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

  constructor(path = join(homedir(), '.jarvis', 'routines.json')) {
    super();
    this.path = path;
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
      cron: input.cron,
      input: input.input ?? '',
      enabled: input.enabled ?? existing?.def.enabled ?? true,
      lastRunAt: existing?.def.lastRunAt ?? null,
      nextRunAt: null,
      condition: input.condition ?? existing?.def.condition,
      lastTaskId: existing?.def.lastTaskId ?? null,
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
    const task = this.runner.launch({
      skillId: def.skillId,
      prompt: def.input || 'Run.',
      origin: 'routine',
    });
    const updated: RoutineDef = {
      ...def,
      lastRunAt: Date.now(),
      lastConditionAt: def.condition ? Date.now() : def.lastConditionAt,
      lastConditionResult: def.condition ? 'fired' : def.lastConditionResult,
      lastTaskId: task.id,
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
          cron: item.cron,
          input: item.input ?? '',
          enabled: item.enabled ?? true,
          lastRunAt: item.lastRunAt ?? null,
          nextRunAt: null,
          condition: item.condition,
          lastTaskId: item.lastTaskId ?? null,
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
      cron: r.def.cron,
      input: r.def.input,
      enabled: r.def.enabled,
      lastRunAt: r.def.lastRunAt ?? undefined,
      condition: r.def.condition,
      lastTaskId: r.def.lastTaskId ?? undefined,
    }));
    writeFileSync(this.path, JSON.stringify(list, null, 2), 'utf8');
  }
}
