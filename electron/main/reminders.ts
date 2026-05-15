import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';

import type { Reminder, ReminderMode, ReminderStatus } from '@shared/types';

interface PersistedReminder {
  id: string;
  body: string;
  mode?: ReminderMode;
  createdAt: number;
  fireAt: number;
  status?: ReminderStatus;
  firedAt?: number | null;
  firedTaskId?: string | null;
}

function isPersisted(v: unknown): v is PersistedReminder {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.body === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.fireAt === 'number'
  );
}

/**
 * Persistent reminders, fired via setTimeout. Survives app restart by
 * rehydrating from JSON and re-scheduling everything still pending. Past-due
 * reminders that we missed (laptop was asleep, app was closed) fire
 * immediately on init — that's almost always what the user wants.
 *
 * Fire effect is delegated via setFireHandler so the store doesn't depend on
 * TaskRunner directly — keeps the module testable and avoids a circular
 * import with main/index.ts.
 */
export class ReminderStore extends EventEmitter {
  private reminders = new Map<string, Reminder>();
  private timers = new Map<string, NodeJS.Timeout>();
  private fireHandler: ((reminder: Reminder) => Promise<void> | void) | null = null;
  readonly path: string;

  constructor(path = join(homedir(), '.jarvis', 'reminders.json')) {
    super();
    this.path = path;
  }

  setFireHandler(fn: (reminder: Reminder) => Promise<void> | void): void {
    this.fireHandler = fn;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.load();
    // Schedule everything still pending. Past-due fire immediately on next
    // tick; setImmediate keeps init() side-effect-free.
    for (const r of this.reminders.values()) {
      if (r.status === 'pending') this.schedule(r);
    }
  }

  list(): Reminder[] {
    // Newest-first, but pending ones float above fired/cancelled.
    return [...this.reminders.values()].sort((a, b) => {
      const aPending = a.status === 'pending' ? 0 : 1;
      const bPending = b.status === 'pending' ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      if (a.status === 'pending') return a.fireAt - b.fireAt;
      return b.createdAt - a.createdAt;
    });
  }

  pendingCount(): number {
    let n = 0;
    for (const r of this.reminders.values()) if (r.status === 'pending') n++;
    return n;
  }

  create(input: { body: string; mode: ReminderMode; fireAt: number }): Reminder {
    const reminder: Reminder = {
      id: nanoid(8),
      body: input.body,
      mode: input.mode,
      createdAt: Date.now(),
      fireAt: input.fireAt,
      status: 'pending',
      firedAt: null,
      firedTaskId: null,
    };
    this.reminders.set(reminder.id, reminder);
    this.persist();
    this.schedule(reminder);
    this.emit('created', reminder);
    this.emit('changed', this.list());
    return reminder;
  }

  cancel(id: string): boolean {
    const r = this.reminders.get(id);
    if (!r) return false;
    if (r.status !== 'pending') return false;
    this.clearTimer(id);
    r.status = 'cancelled';
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  /**
   * Fire a pending reminder right now via the registered fire handler.
   * Equivalent to its timer expiring this moment. Returns true if a fire
   * was triggered (false if the reminder is missing or already fired/cancelled).
   */
  async fireNow(id: string): Promise<boolean> {
    const r = this.reminders.get(id);
    if (!r || r.status !== 'pending') return false;
    await this.fire(id);
    return true;
  }

  remove(id: string): boolean {
    if (!this.reminders.has(id)) return false;
    this.clearTimer(id);
    this.reminders.delete(id);
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  /**
   * Mark a reminder fired and record the task ID it spawned. Called by the
   * registered fire handler after it kicks off the Claude task.
   */
  markFired(id: string, taskId: string | null): void {
    const r = this.reminders.get(id);
    if (!r) return;
    r.status = 'fired';
    r.firedAt = Date.now();
    r.firedTaskId = taskId;
    this.persist();
    this.emit('changed', this.list());
  }

  /**
   * Mark a fired reminder as done — the user acted on it from the inbox.
   * Drops the row from the inbox source but keeps the reminder in
   * history (Reminders page shows it under "Done").
   */
  markDone(id: string): boolean {
    const r = this.reminders.get(id);
    if (!r) return false;
    if (r.status === 'done') return true; // idempotent
    r.status = 'done';
    r.doneAt = Date.now();
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  disposeAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(r: Reminder): void {
    this.clearTimer(r.id);
    const delay = Math.max(0, r.fireAt - Date.now());
    // setTimeout caps at ~24.8 days. Anything beyond, we just re-schedule
    // periodically; for v0 nothing should be that far out, but be safe.
    const MAX = 2_000_000_000;
    if (delay > MAX) {
      const t = setTimeout(() => this.schedule(r), MAX);
      this.timers.set(r.id, t);
      return;
    }
    const t = setTimeout(() => void this.fire(r.id), delay);
    this.timers.set(r.id, t);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  private async fire(id: string): Promise<void> {
    this.clearTimer(id);
    const r = this.reminders.get(id);
    if (!r || r.status !== 'pending') return;
    if (!this.fireHandler) {
      // No handler wired (init order bug). Leave it pending so it doesn't
      // get silently swallowed — emit so the UI can surface the issue.
      this.emit('changed', this.list());
      return;
    }
    try {
      await this.fireHandler(r);
    } catch (e) {
      // Don't move to 'fired' on handler failure — let the user retry by
      // editing/recreating. Surface via event.
      this.emit('error', e);
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!isPersisted(item)) continue;
      const r: Reminder = {
        id: item.id,
        body: item.body,
        mode: item.mode ?? 'reminder',
        createdAt: item.createdAt,
        fireAt: item.fireAt,
        status: item.status ?? 'pending',
        firedAt: item.firedAt ?? null,
        firedTaskId: item.firedTaskId ?? null,
      };
      this.reminders.set(r.id, r);
    }
  }

  private persist(): void {
    const serialized = [...this.reminders.values()].map((r) => ({
      id: r.id,
      body: r.body,
      mode: r.mode,
      createdAt: r.createdAt,
      fireAt: r.fireAt,
      status: r.status,
      firedAt: r.firedAt,
      firedTaskId: r.firedTaskId,
    }));
    writeFileSync(this.path, JSON.stringify(serialized, null, 2));
  }
}
