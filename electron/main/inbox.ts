import { EventEmitter } from 'node:events';

import type { InboxItem } from '@shared/types';

import { InboxDismissalStore } from './inbox-dismissals.js';

/**
 * Daily-driver triage view. Aggregates "things waiting on you" from
 * multiple sources — PRs to review, comments on your PRs, reminders firing
 * today, failed routines — into a single list with 1-click actions.
 *
 * Sources are pluggable: built-ins (reminders, gh-based) ship registered;
 * modules can register additional sources via
 * `ModuleContext.registerInboxSource` later. Each source returns 0+ items
 * with a stable id (used for dedupe across refreshes).
 *
 * Refresh policy: caller-driven for now (user clicks refresh on the tab).
 * A routine that fires `inboxRefresh()` every N minutes lands separately
 * once the standing-watches concept (P3) is built.
 *
 * Electron-free.
 */

export interface InboxSource {
  /** Stable id — also used as the item.source field unless overridden. */
  name: string;
  /** Display label shown in the section header. */
  label: string;
  /**
   * Pull current items. Should be cheap (under ~2 sec) since it runs on
   * every manual refresh. Throw / reject if the source is unavailable
   * (e.g. `gh` not installed) — the store catches + logs and continues.
   */
  fetch(): Promise<InboxItem[]>;
}

export class InboxStore extends EventEmitter {
  private sources: InboxSource[] = [];
  private items: InboxItem[] = [];
  private knownIds = new Set<string>();
  private refreshing = false;
  private lastRefreshedAt = 0;
  private autoTimer: NodeJS.Timeout | null = null;
  private dismissals = new InboxDismissalStore();

  register(source: InboxSource): void {
    const i = this.sources.findIndex((s) => s.name === source.name);
    if (i >= 0) this.sources[i] = source;
    else this.sources.push(source);
  }

  list(): InboxItem[] {
    // Filter snoozed/dismissed items out at read time. Storage stays
    // simple (no need to mutate `items`); time-based reappearance is
    // automatic — once the snoozeUntil passes, the next list() call
    // surfaces the item again.
    return this.items.filter((it) => !this.dismissals.isDismissed(it.id));
  }

  /**
   * Dismissed items still in the current store snapshot — used by the
   * Inbox's "Dismissed" history section. Items no longer emitted by
   * their source (e.g. PRs that have been reviewed) age out of the
   * store entirely and won't appear here; this is the live view, not
   * an audit log.
   */
  listDismissed(): InboxItem[] {
    return this.items.filter((it) => this.dismissals.isDismissed(it.id));
  }

  /** Snooze an item. `snoozeMs` is duration from now; use
   * InboxDismissalStore.forever() to never re-show. */
  dismiss(id: string, snoozeMs: number): void {
    this.dismissals.dismiss(id, snoozeMs);
    this.emit('changed', this.list());
  }

  restore(id: string): void {
    this.dismissals.restore(id);
    this.emit('changed', this.list());
  }

  /** Forever sentinel — for the "stop showing me this" UX. */
  static foreverMs(): number {
    return InboxDismissalStore.forever();
  }

  lastRefresh(): number {
    return this.lastRefreshedAt;
  }

  isRefreshing(): boolean {
    return this.refreshing;
  }

  /**
   * Background poll. Runs refresh() every `intervalMs`. The first refresh
   * fires after a 5-second delay so the renderer can mount + fetch the
   * cached list first (and we don't compete with the manual on-mount
   * refresh). Subsequent ticks emit a 'new-items' event with the freshly
   * appeared items so bootstrap can fire a native notification.
   *
   * Safe to call multiple times — cancels any prior timer.
   */
  startAutoRefresh(intervalMs: number): void {
    this.stopAutoRefresh();
    if (intervalMs <= 0 || !Number.isFinite(intervalMs)) return;
    const tick = async () => {
      try {
        await this.refresh();
      } catch (err) {
        console.warn('Inbox auto-refresh failed:', err);
      }
    };
    // First tick after a short delay; then on the regular cadence.
    this.autoTimer = setTimeout(() => {
      void tick();
      this.autoTimer = setInterval(() => void tick(), intervalMs);
    }, 5_000);
  }

  stopAutoRefresh(): void {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
  }

  /**
   * Run every registered source in parallel. A source that throws is
   * logged and skipped — one broken source must not blank out the inbox.
   * Items are sorted: firing-soonest reminders first, then by createdAt.
   */
  async refresh(): Promise<InboxItem[]> {
    this.refreshing = true;
    this.emit('refreshing', true);
    try {
      const settled = await Promise.allSettled(
        this.sources.map((s) => s.fetch()),
      );
      const all: InboxItem[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]!;
        const source = this.sources[i]!;
        if (r.status === 'fulfilled') {
          all.push(...r.value);
        } else {
          console.warn(`Inbox source "${source.name}" failed:`, r.reason);
        }
      }
      const sorted = all.sort(byPriority);
      // Compute new-items diff. First refresh after launch seeds the
      // baseline silently — we don't want to spam a notification with
      // every existing PR just because Jarvis booted. Dismissed items
      // are also excluded from the "new" set so a snoozed PR doesn't
      // re-ping when the source re-emits it.
      const firstRefresh = this.lastRefreshedAt === 0;
      const fresh = firstRefresh
        ? []
        : sorted.filter(
            (it) =>
              !this.knownIds.has(it.id) && !this.dismissals.isDismissed(it.id),
          );
      this.knownIds = new Set(sorted.map((it) => it.id));
      this.items = sorted;
      this.lastRefreshedAt = Date.now();
      this.emit('changed', this.list());
      if (fresh.length > 0) {
        this.emit('new-items', fresh);
      }
      // Prune expired snoozes opportunistically — keeps the store from
      // growing forever.
      this.dismissals.pruneExpired();
      return this.list();
    } finally {
      this.refreshing = false;
      this.emit('refreshing', false);
    }
  }
}

/**
 * Inbox sort key. We compute an urgency score per item that combines:
 *   - Time pressure (fireAt distance / past-due penalty)
 *   - Source weight (reminders + failed routines + PR comments rank
 *     higher than dedupe / generic items)
 *   - Age (very old items get a small bump so they don't rot)
 *
 * Then sort by score desc, with `fireAt asc` as a tiebreaker so two
 * equally-urgent items still order by the soonest one. Newer items
 * float above older when neither has a fireAt.
 *
 * Why a score and not just fireAt: a 4-day-old PR-review row with no
 * fireAt SHOULD outrank a calendar event tomorrow night. The old
 * "fireAt floats above non-fireAt" rule reversed those.
 */
const SOURCE_WEIGHTS: Record<string, number> = {
  reminders: 100, // direct user-scheduled — bias toward respect
  'failed-routines': 80,
  'pr-comments': 60,
  linear: 50,
  slack: 50,
  'pr-review': 40,
  calendar: 30,
  'meeting-activity': 30,
  dedupe: 10,
};

export function urgencyScore(item: InboxItem, now: number): number {
  let s = 0;
  // Time pressure dominates everything else. Past-due reminders that
  // haven't been acted on stay urgent for 24h.
  if (item.fireAt != null) {
    const dt = item.fireAt - now;
    if (dt > 0) {
      if (dt < 30 * 60_000) s += 1000;
      else if (dt < 4 * 60 * 60_000) s += 200;
      else if (dt < 24 * 60 * 60_000) s += 50;
      else s += 10;
    } else if (dt > -24 * 60 * 60_000) {
      // Fired but not yet handled — still demanding attention.
      s += 500;
    }
  }
  s += SOURCE_WEIGHTS[item.source] ?? 20;
  // Aging: items waiting > 24h get a small bump so a quiet PR review
  // doesn't fall below today's calendar fluff forever.
  if (item.createdAt && now - item.createdAt > 24 * 60 * 60_000) {
    s += 20;
  }
  return s;
}

function byPriority(a: InboxItem, b: InboxItem): number {
  const now = Date.now();
  const sa = urgencyScore(a, now);
  const sb = urgencyScore(b, now);
  if (sa !== sb) return sb - sa; // higher score first
  // Tiebreakers: soonest fireAt, then newest createdAt.
  if (a.fireAt != null && b.fireAt != null) return a.fireAt - b.fireAt;
  if (a.fireAt != null) return -1;
  if (b.fireAt != null) return 1;
  return b.createdAt - a.createdAt;
}
