import { EventEmitter } from 'node:events';
import { Notification } from 'electron';

/**
 * Where a notification originated. Subscribers (e.g. the Telegram bot)
 * route differently based on source — reminders/scheduled-actions always
 * forward, task lifecycle events forward conditionally, skill suggestions
 * never forward by default.
 */
export type NotificationSource =
  | 'notify-tool'         // MCP notify tool fired from inside a task
  | 'reminder'            // a reminder FIRED (not created)
  | 'reminder-created'    // confirming a newly-scheduled reminder
  | 'scheduled-action'    // scheduled action FIRED
  | 'task-launched'       // task transitioned to running
  | 'task-awaiting'       // task awaiting user input
  | 'task-complete'       // task finished successfully
  | 'task-errored'        // task errored or aborted
  | 'meeting-heads-up'    // calendar item starting soon
  | 'cost-guardrail'      // task crossed cost threshold
  | 'inbox-new'           // new items in inbox
  | 'skill-suggestion'    // new skill ideas batch
  | 'other';

export interface NotificationEvent {
  title: string;
  body: string;
  source: NotificationSource;
  taskId?: string;
  reminderId?: string;
  /** Called when the user clicks the OS notification. Subscribers that
   *  don't render OS notifications (e.g. Telegram) ignore this. */
  onClick?: () => void;
  /** Suppress the OS notification sound. Defaults to false. */
  silent?: boolean;
  /** Skip the OS notification entirely — emit only to subscribers. Used
   *  when an MCP handler already showed a popover and we just want the
   *  Telegram mirror. Rare; defaults to false. */
  skipOsNotification?: boolean;
}

type Subscriber = (e: NotificationEvent) => void;

/**
 * Sources that fire automatically (cron tick, calendar proximity,
 * spend threshold, etc.) — anything the user didn't just initiate.
 * When Jarvis is globally paused, these are dropped at the notifier
 * level so they reach neither macOS notifications nor Telegram.
 *
 * Task lifecycle events are NOT in this set: they fire for user-driven
 * palette/voice/Telegram dispatches too, and the user wants to see
 * those even while paused. Routines/workflows that would auto-spawn
 * tasks are already gated at the scheduler — if pause is on, they
 * never produce a task in the first place.
 */
const AUTO_SOURCES = new Set<NotificationSource>([
  'reminder',
  'scheduled-action',
  'meeting-heads-up',
  'inbox-new',
  'cost-guardrail',
  'skill-suggestion',
]);

/**
 * Central fan-out for user-facing notifications. Always fires the macOS
 * native notification, then notifies every subscriber. Subscribers must
 * not throw — they're wrapped in try/catch so one bad sink can't break
 * the rest.
 */
class Notifier extends EventEmitter {
  private subs = new Set<Subscriber>();
  private isPausedFn: (() => boolean) | null = null;

  /**
   * Wire the global pause predicate so the notifier can silence
   * automatic sources when the user has paused Jarvis. Called once
   * at boot from index.ts.
   */
  setPausePredicate(fn: () => boolean): void {
    this.isPausedFn = fn;
  }

  post(e: NotificationEvent): void {
    if (this.isPausedFn?.() && AUTO_SOURCES.has(e.source)) {
      // Silently drop. Activity-feed entries can still be recorded at
      // the source if the caller wants a paper trail (reminders do
      // this) — we just don't push to OS / Telegram / etc.
      return;
    }
    if (!e.skipOsNotification) {
      try {
        const notif = new Notification({
          title: e.title,
          body: e.body,
          silent: !!e.silent,
        });
        if (e.onClick) {
          const cb = e.onClick;
          notif.on('click', () => {
            try {
              cb();
            } catch (err) {
              console.warn('[notifier] onClick threw:', err);
            }
          });
        }
        notif.show();
      } catch {
        // Pre-permission. Not fatal.
      }
    }
    for (const sub of this.subs) {
      try {
        sub(e);
      } catch (err) {
        console.warn('[notifier] subscriber threw:', err);
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}

export const notifier = new Notifier();
