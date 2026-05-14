import type { InboxItem } from '@shared/types';

import type { InboxStore } from './inbox.js';

/**
 * "Heads up, this is starting soon" watcher for inbox items.
 *
 * Polls the inbox every 60s and fires a single notification for each
 * item whose `fireAt` is within the next 5 minutes — the typical
 * use case is calendar events ("meeting in 4 min — click to join"),
 * but any source that sets `fireAt` (scheduled actions, custom
 * countdowns) benefits automatically.
 *
 * Dedupes per item.id — re-tick of the same item doesn't re-notify.
 * Skips `reminders` source items because ReminderStore already fires
 * its own notification at `fireAt` time; the proximity warning would
 * just spam.
 *
 * If an item's fireAt is dismissed via the Inbox snooze, it disappears
 * from list() and we never see it — no special handling needed.
 *
 * Electron-free; the notification side-effect is injected as a
 * callback so this stays portable to server mode (where the notify
 * channel would be push / SMS / email instead of a native popup).
 */

const LOOKAHEAD_MS = 5 * 60 * 1000;
const TICK_MS = 60 * 1000;

export interface ProximityNotifier {
  (item: InboxItem, minutesUntil: number): void;
}

export class InboxProximityWatcher {
  private notified = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private inbox: InboxStore,
    private notify: ProximityNotifier,
  ) {}

  start(): void {
    if (this.timer) return;
    // First check after 10s so we don't fire on the launch wave —
    // a meeting that's already 2 min in shouldn't trigger a fresh
    // "starts in 2 min" popup when Jarvis boots.
    setTimeout(() => this.tick(), 10_000);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    const items = this.inbox.list();

    for (const item of items) {
      if (item.fireAt == null) continue;
      if (item.source === 'reminders') continue;
      const ms = item.fireAt - now;
      if (ms <= 0 || ms > LOOKAHEAD_MS) continue;
      if (this.notified.has(item.id)) continue;
      this.notified.add(item.id);
      try {
        this.notify(item, Math.max(1, Math.round(ms / 60_000)));
      } catch (err) {
        console.warn('InboxProximity: notify callback threw:', err);
      }
    }

    // Forget ids that have passed or are no longer in the list, so a
    // re-emission of the same id (e.g. tomorrow's standup, same uid
    // family) can re-notify. We give a 60s grace after fireAt so a
    // tight interval doesn't unset the flag and re-fire on the next
    // tick.
    const stillRelevant = new Set(
      items.map((it) => (it.fireAt != null && it.fireAt > now - 60_000 ? it.id : null)).filter(Boolean) as string[],
    );
    for (const id of [...this.notified]) {
      if (!stillRelevant.has(id)) this.notified.delete(id);
    }
  }
}
