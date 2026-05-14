import { EventEmitter } from 'node:events';

import type { InboxItem } from '@shared/types';

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

  register(source: InboxSource): void {
    const i = this.sources.findIndex((s) => s.name === source.name);
    if (i >= 0) this.sources[i] = source;
    else this.sources.push(source);
  }

  list(): InboxItem[] {
    return this.items;
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
      // every existing PR just because Jarvis booted.
      const firstRefresh = this.lastRefreshedAt === 0;
      const fresh = firstRefresh
        ? []
        : sorted.filter((it) => !this.knownIds.has(it.id));
      this.knownIds = new Set(sorted.map((it) => it.id));
      this.items = sorted;
      this.lastRefreshedAt = Date.now();
      this.emit('changed', this.items);
      if (fresh.length > 0) {
        this.emit('new-items', fresh);
      }
      return this.items;
    } finally {
      this.refreshing = false;
      this.emit('refreshing', false);
    }
  }
}

/**
 * Inbox sort key. Time-pressured items (reminders firing today) float
 * above everything else; otherwise newest first. The agent uses the same
 * priority ranking when an item is acted on, so order matters for
 * implicit "what should I do first" framing.
 */
function byPriority(a: InboxItem, b: InboxItem): number {
  // Both have fireAt → soonest first.
  if (a.fireAt != null && b.fireAt != null) return a.fireAt - b.fireAt;
  // Only one has fireAt → that one wins.
  if (a.fireAt != null) return -1;
  if (b.fireAt != null) return 1;
  // Neither has fireAt → newer first.
  return b.createdAt - a.createdAt;
}
