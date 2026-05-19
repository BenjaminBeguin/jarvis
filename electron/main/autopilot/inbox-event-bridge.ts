import type { InboxItem, WorkflowDef } from '@shared/types';

import type { InboxStore } from '../inbox.js';
import type { WorkflowRunner } from '../workflow-runner.js';
import type { WorkflowStore } from '../workflow-store.js';

/**
 * Dispatches autopilot workflows whose trigger is
 * `{ kind: 'autopilot', when: 'inbox-changed', sources?: [...] }`
 * whenever a new InboxItem lands under a matching source.
 *
 * Per-`(workflowId, itemId)` dedupe + `minIntervalMs` rate-limit
 * keep a noisy source (many DMs landing at once) from kicking off
 * the workflow per-item; only the FIRST new item per tick fires.
 * The agent's pipeline sees `{ kind: 'inbox-changed', item }` as
 * prev, so the action skill can decide based on the specific item.
 *
 * Skips firing entirely when `appMode !== 'autopilot'` — pause +
 * running modes leave inbox-changed scenarios completely dormant.
 */

export interface InboxEventBridgeDeps {
  inbox: InboxStore;
  workflows: WorkflowStore;
  runner: WorkflowRunner;
  isAutopilot: () => boolean;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;

interface DispatchRecord {
  workflowId: string;
  /** Track which item ids we've dispatched for so duplicate items
   *  don't re-fire across InboxStore refreshes. Capped to 200 ids
   *  per workflow; oldest get evicted. */
  seenItemIds: Map<string, number>;
  lastFiredAt: number;
}

export class InboxEventBridge {
  private readonly deps: InboxEventBridgeDeps;
  private records = new Map<string, DispatchRecord>();
  private known = new Set<string>();
  private off: (() => void) | null = null;
  private started = false;

  constructor(deps: InboxEventBridgeDeps) {
    this.deps = deps;
  }

  /** Subscribe to inbox changes. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Prime the "known" set with the current inbox so workflows
    // don't fire en masse on first start.
    for (const item of this.deps.inbox.list()) this.known.add(item.id);
    const handler = (items: InboxItem[]): void => this.onChanged(items);
    this.deps.inbox.on('changed', handler);
    this.off = () => this.deps.inbox.off('changed', handler);
  }

  close(): void {
    this.off?.();
    this.off = null;
    this.started = false;
  }

  private onChanged(items: InboxItem[]): void {
    // Cheap up-front bail: if no autopilot/inbox-changed workflows
    // exist, just refresh `known` and return.
    const candidates = this.deps.workflows
      .list()
      .filter(
        (w): w is WorkflowDef =>
          w.enabled &&
          w.trigger.kind === 'autopilot' &&
          w.trigger.when === 'inbox-changed',
      );
    const nextKnown = new Set(items.map((i) => i.id));
    if (candidates.length === 0 || !this.deps.isAutopilot()) {
      this.known = nextKnown;
      return;
    }
    // Identify items that are NEW (not in the prior known set).
    const newItems = items.filter((i) => !this.known.has(i.id));
    this.known = nextKnown;
    if (newItems.length === 0) return;

    for (const def of candidates) {
      const trigger = def.trigger as { kind: 'autopilot'; when: 'inbox-changed'; sources?: string[]; minIntervalMs?: number };
      const sources = trigger.sources ?? [];
      const matching = newItems.filter(
        (item) => sources.length === 0 || sources.includes(item.source),
      );
      if (matching.length === 0) continue;

      const record = this.recordFor(def.id);
      const interval = trigger.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
      const now = Date.now();
      if (now - record.lastFiredAt < interval) continue;

      // Pick the first not-yet-dispatched item. Stable ordering by
      // createdAt so the user perceives newest-first triage.
      const sorted = matching
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
      const pick = sorted.find((item) => !record.seenItemIds.has(item.id));
      if (!pick) continue;

      record.seenItemIds.set(pick.id, now);
      record.lastFiredAt = now;
      // Evict oldest ids when the cap is reached.
      if (record.seenItemIds.size > 200) {
        const ids = [...record.seenItemIds.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, record.seenItemIds.size - 200);
        for (const [id] of ids) record.seenItemIds.delete(id);
      }

      try {
        const fresh = this.deps.workflows.get(def.id);
        if (!fresh || !fresh.enabled) continue;
        // Feed the matched InboxItem in as prev — the pipeline's
        // first transform / run-skill step receives `$` = the item.
        this.deps.runner.runWithSeed(fresh, 'inbox-event', { kind: 'inbox-changed', item: pick });
      } catch (err) {
        console.warn(`[inbox-event-bridge] ${def.id} fire failed:`, err);
      }
    }
  }

  private recordFor(workflowId: string): DispatchRecord {
    let record = this.records.get(workflowId);
    if (!record) {
      record = { workflowId, seenItemIds: new Map(), lastFiredAt: 0 };
      this.records.set(workflowId, record);
    }
    return record;
  }
}

