import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';
import type { ReminderStore } from '../reminders.js';

/**
 * Reminders firing in the next 24 hours. Today's events are the most
 * actionable — older pending reminders are usually noise the user has
 * dismissed in their head. We show fireAt as relative time ("in 2h") in
 * the renderer; main just hands over the ms.
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
        .filter((r) => r.status === 'pending' && r.fireAt <= horizon)
        .map((r) => ({
          id: `reminder-${r.id}`,
          source: 'reminders',
          title: r.body,
          subtitle: r.mode === 'scheduled' ? 'Scheduled action' : 'Reminder',
          fireAt: r.fireAt,
          createdAt: r.fireAt, // we don't track createdAt separately
        }));
    },
  };
}
