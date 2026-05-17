import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Module } from './types.js';

function slugifyProject(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function dateKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function timeKey(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const quickNoteModule: Module = {
  id: 'quick-note',
  name: 'Notes & Reminders',
  description:
    "Capture-for-later: free-form notes (markdown journal) + time-pressured reminders. /note appends to today's journal; /reminders opens the reminders tab on the same page.",
  settings: {
    description:
      'Tune how the Notes & Reminders surface behaves. Auto-dedupe cadence drives a managed routine that scans recent captures and writes merge proposals to the Inbox.',
    fields: [
      {
        key: 'dedupeCadence',
        label: 'Auto-dedupe cadence',
        hint: 'How often Jarvis scans recent notes + pending reminders for duplicates / near-duplicates and proposes merges. Proposals show up in the Inbox under "Possible duplicates".',
        type: 'select',
        default: 'off',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ],
      },
      {
        key: 'dedupeSensitivity',
        label: 'Dedupe sensitivity',
        hint: 'How aggressive the similarity match is. Higher = more merge proposals, more false positives.',
        type: 'select',
        default: 'medium',
        options: [
          { value: 'low', label: 'Low — exact matches only' },
          { value: 'medium', label: 'Medium — close paraphrases' },
          { value: 'high', label: 'High — same intent, different words' },
        ],
      },
    ],
  },
  version: '1.0.0',
  intents: [
    {
      id: 'note',
      prefix: '/note',
      label: 'Quick note',
      description: 'Append to today\'s journal',
      placeholder: 'What\'s on your mind?',
      verbalTriggers: [
        'note',
        'take a note',
        'make a note',
        'jot down',
        'jot this down',
        'remember this',
        'write this down',
      ],
      handler: async (input, ctx) => {
        const raw = input.trim();
        if (!raw) throw new Error('Note is empty');

        // Project scoping: "<alias>: <body>" lands the note under
        // ~/.jarvis/notes/<project>/<date>.md if <alias> resolves. Otherwise
        // it's a global note.
        let text = raw;
        let projectName: string | null = null;
        const m = /^([\w-]+)\s*:\s*(.+)$/s.exec(raw);
        if (m) {
          const candidate = m[1]!;
          const project = ctx.resolveProject(candidate);
          if (project) {
            projectName = project.name;
            text = m[2]!.trim();
          }
        }

        const now = new Date();
        const dir = projectName
          ? join(ctx.jarvisRoot, 'notes', slugifyProject(projectName))
          : join(ctx.jarvisRoot, 'notes');
        const filePath = join(dir, `${dateKey(now)}.md`);
        mkdirSync(dirname(filePath), { recursive: true });
        const block = `\n## ${timeKey(now)}\n\n${text}\n`;
        appendFileSync(filePath, block, 'utf8');
        const rel = filePath.replace(ctx.jarvisRoot, '~/.jarvis');
        ctx.logActivity({
          kind: 'note.created',
          label: projectName
            ? `Note saved · ${projectName} · ${rel}`
            : `Note saved · ${rel}`,
          detail: { project: projectName, path: filePath, snippet: text.slice(0, 120) },
        });

        // Smart-note: if the user wrote something with a time phrase
        // ("remind me in 2h about X", "ping luca at 17:30 …", "every
        // Monday at 9am send the recap"), also create a reminder /
        // scheduled action. The note itself is always saved so the user
        // keeps the original; the reminder gives them the wake-up.
        // Recurring patterns pass `cron` through so the reminder
        // reschedules itself on each fire instead of being one-shot.
        const intent = ctx.parseFreeTextIntent(text);
        if (intent.kind === 'reminder') {
          const r = ctx.createReminder({
            body: intent.body,
            mode: intent.mode,
            fireAt: intent.fireAt,
            cron: intent.cron,
          });
          const when = new Date(r.fireAt).toLocaleString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            day: 'numeric',
            month: 'short',
          });
          const recurringSuffix = intent.cron ? ' · recurring' : '';
          // Smart-note created BOTH a note and a reminder — log the
          // reminder side too so the Activity feed shows the chain.
          ctx.logActivity({
            kind: 'reminder.created',
            label: `${intent.mode === 'scheduled' ? 'Scheduled' : 'Reminder set'}${recurringSuffix} (via /note) · ${r.body.slice(0, 80)}${r.body.length > 80 ? '…' : ''}`,
            detail: {
              reminderId: r.id,
              mode: intent.mode,
              fireAt: r.fireAt,
              cron: intent.cron ?? null,
              fromNote: true,
            },
          });
          ctx.notify(
            intent.mode === 'scheduled'
              ? `Note · scheduled ${when}${recurringSuffix}`
              : `Note · reminder ${when}${recurringSuffix}`,
            r.body,
          );
          return `Saved + ${intent.mode === 'scheduled' ? 'scheduled' : 'reminder'}${recurringSuffix} · ${when}`;
        }

        ctx.notify(
          projectName ? `Note saved · ${projectName}` : 'Note saved',
          rel,
        );
        return `Saved · ${rel}`;
      },
    },
  ],
};
