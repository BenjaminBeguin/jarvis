import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Per-item dismiss + snooze state. The Inbox fills back up forever
 * unless the user can say "stop bugging me about this one" — this
 * store is that escape hatch.
 *
 * Persisted to `~/.jarvis/inbox/.dismissed.json` as a flat map
 * `{ id: snoozeUntilMs }`. Items whose snoozeUntil is in the future
 * are hidden from `list()`; once the timestamp passes, they
 * reappear naturally on the next refresh. "Dismiss forever" sets a
 * far-future timestamp.
 *
 * Lazy-load. Cache invalidates by reading mtime — cheap and avoids
 * a chokidar handle for a file the user almost never touches.
 *
 * Electron-free; survives a future move to server mode.
 */

const STORE_PATH = join(homedir(), '.jarvis', 'inbox', '.dismissed.json');
const FOREVER = 4_102_444_800_000; // 2100-01-01 UTC

export class InboxDismissalStore {
  private cache: Map<string, number> = new Map();
  private cachedMtime = 0;

  load(): Map<string, number> {
    let mtime = 0;
    if (existsSync(STORE_PATH)) {
      try {
        mtime = statSync(STORE_PATH).mtimeMs;
      } catch {
        mtime = 0;
      }
    }
    if (mtime === this.cachedMtime && this.cache.size > 0) {
      return this.cache;
    }
    if (!existsSync(STORE_PATH)) {
      this.cache = new Map();
      this.cachedMtime = 0;
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
      const next = new Map<string, number>();
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === 'number') next.set(k, v);
        }
      }
      this.cache = next;
      this.cachedMtime = mtime;
    } catch (err) {
      console.warn('Inbox dismissals: failed to read store:', err);
      this.cache = new Map();
    }
    return this.cache;
  }

  /** True if the item is currently snoozed (not yet expired). */
  isDismissed(id: string): boolean {
    const until = this.load().get(id);
    if (until == null) return false;
    return until > Date.now();
  }

  /**
   * Snooze for the given duration in ms. Use `forever()` (or any
   * comically large ms) to never re-show.
   */
  dismiss(id: string, snoozeMs: number): void {
    const map = this.load();
    map.set(id, Date.now() + snoozeMs);
    this.persist();
  }

  /** Un-snooze a single id — the item will reappear on next refresh. */
  restore(id: string): void {
    const map = this.load();
    if (map.delete(id)) this.persist();
  }

  /** Wipe expired entries from disk. Cheap housekeeping; safe to call. */
  pruneExpired(): void {
    const map = this.load();
    const now = Date.now();
    let changed = false;
    for (const [id, until] of map) {
      if (until <= now) {
        map.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  static forever(): number {
    return FOREVER - Date.now();
  }

  private persist(): void {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [k, v] of this.cache) obj[k] = v;
    writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), 'utf8');
    this.cachedMtime = Date.now();
  }
}
