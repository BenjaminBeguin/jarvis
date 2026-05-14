import type { InboxItem } from '@shared/types';

import type { InboxStore } from './inbox.js';

/**
 * Time-pressured prompts for inbox items.
 *
 * Two windows, two callbacks:
 *
 *   1. **Heads up (5 min)** — fires once when any item's fireAt is
 *      within 5 minutes. Routed to a native macOS notification with
 *      a click-handler that opens the item URL (Google Meet etc.) or
 *      jumps to the Inbox. Works for any source with a fireAt.
 *
 *   2. **Imminent meeting (≤ 2 min)** — when the item looks like a
 *      meeting (URL matches Meet/Zoom/Teams/etc., or source is
 *      'calendar'), fires the more intrusive "want to record this?"
 *      prompt that surfaces in the renderer as an actionable toast.
 *
 * Dedupes per item.id per window — re-tick of the same item doesn't
 * re-fire either prompt. Skips `reminders` source items entirely
 * because ReminderStore handles those at fireAt time.
 *
 * Electron-free; both callbacks are injected so this is portable to
 * server mode (where the meeting-prompt becomes push / phone tap
 * instead of an in-window overlay).
 */

const LOOKAHEAD_MS = 5 * 60 * 1000;
const IMMINENT_MS = 2 * 60 * 1000;
const TICK_MS = 60 * 1000;

const MEETING_URL_PATTERN =
  /https?:\/\/[a-z0-9.-]*(?:meet\.google|zoom\.us|teams\.microsoft|webex|whereby|jit\.si|jitsi)[^\s]*/i;

function isMeetingShaped(item: InboxItem): boolean {
  if (item.source === 'calendar') return true;
  if (item.url && MEETING_URL_PATTERN.test(item.url)) return true;
  return false;
}

export interface ProximityNotifier {
  (item: InboxItem, minutesUntil: number): void;
}

export interface MeetingPrompter {
  (item: InboxItem, minutesUntil: number): void;
}

export class InboxProximityWatcher {
  private notified = new Set<string>();
  private meetingPrompted = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private inbox: InboxStore,
    private notify: ProximityNotifier,
    private promptMeeting?: MeetingPrompter,
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
      if (ms <= 0) continue;

      // 5-min heads-up notification (any item with fireAt)
      if (ms <= LOOKAHEAD_MS && !this.notified.has(item.id)) {
        this.notified.add(item.id);
        try {
          this.notify(item, Math.max(1, Math.round(ms / 60_000)));
        } catch (err) {
          console.warn('InboxProximity: notify callback threw:', err);
        }
      }

      // 2-min "record this?" meeting prompt (calendar / meet-URL items)
      if (
        ms <= IMMINENT_MS &&
        this.promptMeeting &&
        isMeetingShaped(item) &&
        !this.meetingPrompted.has(item.id)
      ) {
        this.meetingPrompted.add(item.id);
        try {
          this.promptMeeting(item, Math.max(1, Math.round(ms / 60_000)));
        } catch (err) {
          console.warn('InboxProximity: meeting prompt threw:', err);
        }
      }
    }

    // Forget ids that have passed or are no longer in the list, so a
    // re-emission of the same id (e.g. tomorrow's standup, same uid
    // family) can re-notify. 60s grace after fireAt so a tight
    // interval doesn't unset the flag and re-fire on the next tick.
    const stillRelevant = new Set(
      items.map((it) => (it.fireAt != null && it.fireAt > now - 60_000 ? it.id : null)).filter(Boolean) as string[],
    );
    for (const id of [...this.notified]) {
      if (!stillRelevant.has(id)) this.notified.delete(id);
    }
    for (const id of [...this.meetingPrompted]) {
      if (!stillRelevant.has(id)) this.meetingPrompted.delete(id);
    }
  }

  /**
   * Caller-side override: when the user clicks "Skip" on a meeting
   * prompt, suppress further prompts for the same id (until the item
   * leaves the inbox or fireAt passes).
   */
  suppressMeetingPrompt(id: string): void {
    this.meetingPrompted.add(id);
  }
}
