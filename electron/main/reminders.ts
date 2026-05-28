import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';

import { nextCronFire } from '@shared/cron';
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
  doneAt?: number | null;
  cron?: string | null;
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

  create(input: {
    body: string;
    mode: ReminderMode;
    fireAt: number;
    /** When provided, the reminder becomes recurring — after each fire
     *  the store reschedules to the next cron occurrence. */
    cron?: string;
    /** Optional link back to whatever spawned this reminder — the
     *  inbox row's click affordance uses it. Today: meeting-actions
     *  passes vscode://file<transcript-path> so the user can jump
     *  back to the meeting that produced the action item. */
    sourceUrl?: string;
    sourceLabel?: string;
  }): Reminder {
    const reminder: Reminder = {
      id: nanoid(8),
      body: input.body,
      mode: input.mode,
      createdAt: Date.now(),
      fireAt: input.fireAt,
      status: 'pending',
      firedAt: null,
      firedTaskId: null,
      cron: input.cron ?? null,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
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
   *
   * Recurring reminders (cron set) DON'T flip to 'fired' — the store
   * reschedules them to the next cron occurrence and stamps firedAt
   * so the UI can show "last fired N ago." Status stays 'pending'
   * so they continue to show as a live commitment. Mark done /
   * cancel to stop the series entirely.
   */
  markFired(id: string, taskId: string | null): void {
    const r = this.reminders.get(id);
    if (!r) return;
    if (r.cron) {
      // Recurring — reschedule for the next occurrence. +1s on the
      // search window so we don't immediately re-pick the same minute.
      const next = nextCronFire(r.cron, Date.now() + 1000);
      if (next) {
        r.fireAt = next;
        r.firedAt = Date.now();
        r.firedTaskId = taskId;
        // status stays 'pending'
        this.persist();
        this.schedule(r);
        this.emit('changed', this.list());
        return;
      }
      // Cron parse failure — fall through to one-shot fired so the
      // reminder stops looping. User can inspect/repair from the
      // Reminders page.
      console.warn(
        `[reminders] cron ${r.cron} produced no next fire; treating as one-shot.`,
      );
    }
    r.status = 'fired';
    r.firedAt = Date.now();
    r.firedTaskId = taskId;
    this.persist();
    this.emit('changed', this.list());
  }

  /**
   * Re-arm a reminder to fire `msFromNow` ms from now. Works on any reminder
   * regardless of current status (pending/fired/done/cancelled) — moves it
   * back to `pending` and reschedules. Useful for Telegram `[Snooze 1h]`
   * buttons and any future per-row snooze affordance in the renderer.
   * Returns the updated reminder, or null if id is unknown.
   */
  snooze(id: string, msFromNow: number): Reminder | null {
    const r = this.reminders.get(id);
    if (!r) return null;
    this.clearTimer(id);
    r.fireAt = Date.now() + Math.max(0, msFromNow);
    r.status = 'pending';
    r.firedAt = null;
    r.firedTaskId = null;
    r.doneAt = null;
    this.persist();
    this.schedule(r);
    this.emit('changed', this.list());
    return r;
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
        doneAt: typeof item.doneAt === 'number' ? item.doneAt : null,
        cron: typeof item.cron === 'string' ? item.cron : null,
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
      doneAt: r.doneAt ?? null,
      cron: r.cron ?? null,
    }));
    writeFileSync(this.path, JSON.stringify(serialized, null, 2));
  }
}
