import type { Module } from './types.js';

/**
 * The Reminders module is a thin pass-through whose only job is to
 * register a renderer page (see RemindersPage in src/renderer/modules/).
 * Reminders are owned by `ReminderStore` in main and surfaced via the
 * existing list/cancel/remove/fireNow IPC handlers; this module just
 * gives them a tab to live in.
 *
 * Palette intent: `/reminders` opens the page directly via the
 * shell-nav broadcast pattern.
 */
export const remindersModule: Module = {
  id: 'reminders',
  name: 'Reminders',
  description:
    'See every reminder + scheduled action you have set — upcoming, fired, cancelled — with cancel / fire-now controls.',
  version: '1.0.0',
  intents: [
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
        ctx.broadcast('shell:navigate', {
          tab: 'settings',
          moduleId: 'reminders',
        });
        return 'Opening reminders';
      },
    },
  ],
};
