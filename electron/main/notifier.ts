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
 * Central fan-out for user-facing notifications. Always fires the macOS
 * native notification, then notifies every subscriber. Subscribers must
 * not throw — they're wrapped in try/catch so one bad sink can't break
 * the rest.
 */
class Notifier extends EventEmitter {
  private subs = new Set<Subscriber>();

  post(e: NotificationEvent): void {
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
