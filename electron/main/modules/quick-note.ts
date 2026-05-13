import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Module } from './types.js';

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
      handler: async (input, ctx) => {
        const text = input.trim();
        if (!text) throw new Error('Note is empty');
        const now = new Date();
        const filePath = join(ctx.jarvisRoot, 'notes', `${dateKey(now)}.md`);
        mkdirSync(dirname(filePath), { recursive: true });
        const block = `\n## ${timeKey(now)}\n\n${text}\n`;
        appendFileSync(filePath, block, 'utf8');
        const rel = filePath.replace(ctx.jarvisRoot, '~/.jarvis');
        ctx.notify('Note saved', rel);
        return `Saved · ${rel}`;
      },
    },
  ],
};
