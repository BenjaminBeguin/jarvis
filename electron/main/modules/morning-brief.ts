import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shell } from 'electron';

import type { Module } from './types.js';

const WORKFLOW_ID = 'morning-brief-loop';
const BRIEFINGS_DIR = join(
  homedir(),
  '.jarvis',
  'briefings',
  'today-focus',
);

/**
 * Morning brief module — discoverable wrapper around the
 * `today-focus` skill + `morning-brief-loop` workflow.
 *
 * The pieces already existed (today-focus skill is a built-in
 * briefing kind; the BriefingsStore handles the file collection).
 * What was missing: a) automatic firing on a cadence, b) surfacing
 * the recommended next move in the Inbox where the user actually
 * triages, c) a single discoverable palette command + verbal
 * trigger so "give me my morning brief" maps to the right thing.
 *
 * This module is all wrapper — declares the memory map, exposes
 * /morning-brief to fire on demand, opens the briefings folder
 * via /open-brief. The actual scheduling lives in the workflow;
 * the actual content generation lives in the skill.
 */
export const morningBriefModule: Module = {
  id: 'morning-brief',
  name: 'Morning brief',
  description:
    'Every weekday at 08:15, generates a forward-looking brief (calendar + waiting-on-me + reminders + heads-up) with one recommended next move. Lands in the Briefings tab AND as a top-priority Inbox item.',
  version: '1.0.0',
  memory: [
    {
      label: 'Daily briefing files',
      location: '~/.jarvis/briefings/today-focus/<YYYY-MM-DD>.md',
      kind: 'directory',
      access: 'write',
      notes:
        "Full markdown brief — recommended next move, calendar, waiting-on-me, scheduled, open-from-yesterday, heads-up. One file per day; never overwritten across days. Surfaced in the Briefings tab.",
    },
    {
      label: 'Inbox item (today only)',
      location: '~/.jarvis/inbox/today-focus.json',
      kind: 'file',
      access: 'write',
      notes:
        'Single inbox item carrying the recommended next move + a vscode:// link to the full briefing. Rewritten each morning. Smart-inbox curator picks it up alongside everything else.',
    },
    {
      label: 'Workflow definition',
      location: '~/.jarvis/workflows/morning-brief-loop.json',
      kind: 'file',
      access: 'read',
      notes:
        'Cron: 15 8 * * 1-5 (08:15 weekdays). Default enabled — first weekday morning after install lands a brief with no setup. Disable in Settings → Workflows if too noisy.',
    },
    {
      label: 'Skill body',
      location: '~/.jarvis/skills/today-focus/SKILL.md',
      kind: 'file',
      access: 'read',
      notes:
        "Reads inbox + PR review queue + reminders + calendar + active project. Writes the markdown file AND the inbox JSON. balanced tier by default — synthesises across sources so haiku isn't sharp enough.",
    },
  ],
  intents: [
    {
      id: 'run-now',
      prefix: '/morning-brief',
      label: 'Generate morning brief now',
      description:
        "Fire the brief immediately instead of waiting for 08:15. Useful when you want a fresh recommendation mid-day after handling the first wave.",
      verbalTriggers: [
        'morning brief',
        'todays brief',
        'today brief',
        'brief me on today',
        'what is on for today',
        "what's on for today",
      ],
      handler: (_input, ctx) => {
        try {
          const run = ctx.runWorkflow(WORKFLOW_ID);
          return `Morning brief running · #${run.id.slice(0, 6)}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('not found') || msg.includes('unknown')) {
            return 'Workflow `morning-brief-loop` not installed. Reseed via app restart, or drop the JSON yourself.';
          }
          return `Couldn't fire: ${msg}`;
        }
      },
    },
    {
      id: 'open-brief',
      prefix: '/open-brief',
      label: "Open today's brief",
      description:
        "Reveal today's briefing markdown file in Finder (or the briefings folder if nothing's been generated yet)",
      verbalTriggers: ['open brief', 'show brief', "open today's brief"],
      handler: async () => {
        if (!existsSync(BRIEFINGS_DIR)) {
          return 'No briefings generated yet. Try /morning-brief to fire one now.';
        }
        // Find the most recent file in the briefings dir.
        try {
          const files = readdirSync(BRIEFINGS_DIR)
            .filter((f) => f.endsWith('.md'))
            .map((f) => ({
              name: f,
              path: join(BRIEFINGS_DIR, f),
              mtime: statSync(join(BRIEFINGS_DIR, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length === 0) {
            shell.showItemInFolder(BRIEFINGS_DIR);
            return 'No briefing files yet — opened the folder so you can verify.';
          }
          shell.showItemInFolder(files[0]!.path);
          return `Opened ${files[0]!.name}`;
        } catch (e) {
          return `Couldn't open: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
  ],
};
