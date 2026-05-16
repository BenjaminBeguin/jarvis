import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';
import type { ReminderStore } from '../reminders.js';

/**
 * Reminders in the inbox — both:
 *   - pending reminders firing in the next 24h (so the user sees them
 *     before they fire and can re-arrange if needed), and
 *   - fired reminders that haven't been marked done yet (the to-do
 *     list semantics: the row stays until you say you did it).
 *
 * Done and cancelled reminders never appear — they live in history
 * (Reminders page → Done / Cancelled groups).
 */
export function remindersInboxSource(reminders: ReminderStore): InboxSource {
  return {
    name: 'reminders',
    label: 'Scheduled',
    async fetch(): Promise<InboxItem[]> {
      const now = Date.now();
      const horizon = now + 24 * 60 * 60 * 1000;
      return reminders
        .list()
        .filter((r) => {
          if (r.status === 'pending') return r.fireAt <= horizon;
          if (r.status === 'fired') return true;
          return false; // done / cancelled
        })
        .map((r) => {
          const fired = r.status === 'fired';
          const baseLabel =
            r.mode === 'scheduled' ? 'Scheduled action' : 'Reminder';
          const recurringTag = r.cron ? ' · 🔁 recurring' : '';
          const subtitle = fired
            ? `${baseLabel} · awaiting done${recurringTag}`
            : `${baseLabel}${recurringTag}`;
          return {
            id: `reminder-${r.id}`,
            source: 'reminders',
            title: r.body,
            subtitle,
            // For fired reminders we surface firedAt so the row sorts
            // by "when you got the nudge" rather than the original
            // fireAt (which is now in the past).
            fireAt: fired ? (r.firedAt ?? r.fireAt) : r.fireAt,
            createdAt: r.createdAt,
          };
        });
    },
  };
}
