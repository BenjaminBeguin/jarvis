import type { Module } from './types.js';

/**
 * The Reminders module ships two palette intents:
 *
 *   /remind <body with time> — create a reminder or scheduled action.
 *     Parses the body via the shared free-text intent router; reuses
 *     the exact same grammar as just typing "remind me in 2h to …" in
 *     the palette directly. The slash prefix is a discoverable
 *     shortcut + an explicit signal "this is a reminder, don't
 *     second-guess."
 *
 *   /reminders — open the merged Notes & Reminders page on the
 *     Reminders tab. Pure navigation.
 *
 * Reminders themselves are owned by ReminderStore in main, surfaced
 * through the existing list / cancel / remove / fireNow / markDone
 * IPC handlers.
 */
export const remindersModule: Module = {
  id: 'reminders',
  name: 'Reminders',
  description:
    'Create reminders via /remind and browse them via /reminders. Both reminder-style nudges and scheduled actions ("in 2h, …") are supported.',
  version: '1.0.0',
  intents: [
    {
      id: 'create',
      prefix: '/remind',
      label: 'Add reminder',
      description: 'e.g. "in 2h to check the deploy" or "tomorrow 9am send the recap"',
      placeholder: 'in 2h to check the deploy',
      verbalTriggers: [
        'add reminder',
        'add a reminder',
        'create reminder',
        'create a reminder',
        'new reminder',
        'remind me to',
        'remind me',
      ],
      handler: (input, ctx) => {
        const body = input.trim();
        if (!body) {
          return 'Need a time + a body. Try "/remind in 2h to check the deploy".';
        }
        // Reuse the free-text intent router so the grammar is identical
        // to "type it raw in the palette." Anything it would normally
        // parse as a reminder/scheduled action lands here too.
        const parsed = ctx.parseFreeTextIntent(body);
        if (parsed.kind !== 'reminder') {
          return 'Couldn\'t find a time phrase. Try "in 2h", "tomorrow 9am", "at 17:30".';
        }
        const r = ctx.createReminder({
          body: parsed.body,
          mode: parsed.mode,
          fireAt: parsed.fireAt,
        });
        const when = new Date(r.fireAt).toLocaleString(undefined, {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          day: 'numeric',
          month: 'short',
        });
        ctx.notify(
          parsed.mode === 'scheduled'
            ? `Scheduled · ${when}`
            : `Reminder · ${when}`,
          r.body,
        );
        return `${parsed.mode === 'scheduled' ? 'Scheduled' : 'Reminder set'} · ${when}`;
      },
    },
    {
      id: 'open',
      prefix: '/reminders',
      label: 'Open reminders',
      description: 'Browse every reminder you have set',
      verbalTriggers: [
        'show reminders',
        'open reminders',
        'list reminders',
        'my reminders',
      ],
      handler: (_input, ctx) => {
        // Reminders + Notes share the same merged page now; the
        // captureTab field tells CapturePage which tab to land on.
        ctx.broadcast('shell:navigate', {
          tab: 'settings',
          moduleId: 'quick-note',
          captureTab: 'reminders',
        });
        return 'Opening reminders';
      },
    },
  ],
};
