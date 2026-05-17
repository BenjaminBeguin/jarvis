import { EventEmitter } from 'node:events';

import { byUrgency } from '@shared/inbox-urgency';
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

  /**
   * Item bucket fed by workflow `inbox-write` nodes. Each workflow
   * run replaces its named bucket. Auto-registers a trivial
   * InboxSource the first time a bucket appears so the existing
   * `refresh()` aggregation flow stays uniform — no special-casing
   * "workflow items" vs "source items" downstream.
   *
   * Triggers an immediate items-list refresh so the UI updates as
   * soon as the workflow finishes, without waiting for the next
   * auto-refresh tick.
   */
  private externalItems = new Map<string, InboxItem[]>();
  setExternalItems(
    sourceName: string,
    label: string,
    items: InboxItem[],
  ): void {
    this.externalItems.set(sourceName, items);
    if (!this.sources.some((s) => s.name === sourceName)) {
      this.register({
        name: sourceName,
        label,
        // Trivial fetch: hand back the latest items the workflow wrote.
        // The workflow's own cron drives when those items refresh.
        fetch: async () => this.externalItems.get(sourceName) ?? [],
      });
    }
    // Fire a refresh so the UI reflects new items immediately —
    // refresh() pulls from every registered source including this
    // one's trivial fetch, runs the dedup + sort, emits 'changed'.
    void this.refresh();
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
      const sorted = all.sort((a, b) => byUrgency(a, b));
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

