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
  name: 'Quick note',
  description: "Append a timestamped note to today's journal markdown file",
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
        // ("remind me in 2h about X", "ping luca at 17:30 …"), also create
        // a reminder/scheduled action. The note itself is always saved so
        // the user keeps the original; the reminder gives them the wake-up.
        const intent = ctx.parseFreeTextIntent(text);
        if (intent.kind === 'reminder') {
          const r = ctx.createReminder({
            body: intent.body,
            mode: intent.mode,
            fireAt: intent.fireAt,
          });
          const when = new Date(r.fireAt).toLocaleString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            day: 'numeric',
            month: 'short',
          });
          ctx.notify(
            intent.mode === 'scheduled' ? `Note · scheduled ${when}` : `Note · reminder ${when}`,
            r.body,
          );
          return `Saved + ${intent.mode === 'scheduled' ? 'scheduled' : 'reminder'} · ${when}`;
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
