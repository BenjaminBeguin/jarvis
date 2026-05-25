import type { Reminder } from '@shared/types';

import type { Module, ModuleContext } from './types.js';

// Captured in onLoad so onUnload — which doesn't receive ctx — can
// still call unregister. Module is a singleton; safe to hold one ref.
let savedCtx: ModuleContext | null = null;

/**
 * The Reminders module ships two palette intents + the reminders
 * ambient-context provider.
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
 * The context provider surfaces pending reminders firing in the next
 * 24h so any Claude turn can answer "what do I have set?" / "what
 * fires today?" from cached context — no tool round-trip.
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
  memory: [
    {
      label: 'Reminders (pending + history)',
      location: '~/.jarvis/reminders.json',
      kind: 'file',
      access: 'read-write',
      notes:
        'Owned by ReminderStore in core. Persists across restarts; past-due fires re-arm on boot.',
    },
  ],
  onLoad(ctx) {
    savedCtx = ctx;
    ctx.registerContextProvider({
      name: 'reminders',
      build: () => buildRemindersContext(ctx.listReminders()),
    });
  },
  onUnload() {
    savedCtx?.unregisterContextProvider('reminders');
    savedCtx = null;
  },
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
          return 'Need a time + a body. Try "/remind in 2h to check the deploy" or "/remind every Monday at 9am to send the recap".';
        }
        // Reuse the free-text intent router so the grammar is identical
        // to "type it raw in the palette." Recurring patterns ("every
        // Monday at 9am") come back with parsed.cron set; the store
        // reschedules on each fire.
        const parsed = ctx.parseFreeTextIntent(body);
        if (parsed.kind !== 'reminder') {
          return 'Couldn\'t find a time phrase. Try "in 2h", "tomorrow 9am", "at 17:30", or "every Monday at 9am".';
        }
        const r = ctx.createReminder({
          body: parsed.body,
          mode: parsed.mode,
          fireAt: parsed.fireAt,
          cron: parsed.cron,
        });
        const when = new Date(r.fireAt).toLocaleString(undefined, {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          day: 'numeric',
          month: 'short',
        });
        const recurringSuffix = parsed.cron ? ' · recurring' : '';
        ctx.notify(
          parsed.mode === 'scheduled'
            ? `Scheduled · ${when}${recurringSuffix}`
            : `Reminder · ${when}${recurringSuffix}`,
          r.body,
        );
        const label =
          parsed.mode === 'scheduled'
            ? parsed.cron
              ? 'Recurring scheduled action'
              : 'Scheduled'
            : parsed.cron
              ? 'Recurring reminder'
              : 'Reminder set';
        ctx.logActivity({
          kind: 'reminder.created',
          label: `${label} · ${r.body.slice(0, 80)}${r.body.length > 80 ? '…' : ''}`,
          detail: {
            reminderId: r.id,
            mode: parsed.mode,
            fireAt: r.fireAt,
            cron: parsed.cron ?? null,
          },
        });
        return `${label} · ${when}${recurringSuffix}`;
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

/**
 * Pending reminders firing in the next 24h. Past-due ones (status
 * pending but fireAt < now) are included with a LATE marker — they
 * didn't fire (likely because Jarvis was paused at the time) and the
 * user might want to act on them. Returns null when nothing's queued,
 * so the provider stays silent.
 */
function buildRemindersContext(reminders: Reminder[]): string | null {
  const now = Date.now();
  const horizon = now + 24 * 60 * 60 * 1000;
  const due = reminders
    .filter((r) => r.status === 'pending' && r.fireAt <= horizon)
    .sort((a, b) => a.fireAt - b.fireAt)
    .slice(0, 5);
  if (due.length === 0) return null;
  const lines = due.map((r) => {
    const late = r.fireAt < now - 60_000 ? ' (LATE)' : '';
    const when = new Date(r.fireAt).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const kind = r.mode === 'scheduled' ? 'action' : 'nudge';
    const body = r.body.length > 70 ? `${r.body.slice(0, 70)}…` : r.body;
    return `  - ${when}${late} [${kind}] ${body}`;
  });
  return `- Reminders next 24h:\n${lines.join('\n')}`;
}
