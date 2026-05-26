import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shell } from 'electron';

import type { Module } from './types.js';

const WORKFLOW_ID = 'daily-learn-loop';
const LEARNINGS_DIR = join(homedir(), '.jarvis', 'learnings');
const INFERRED_FILE = join(LEARNINGS_DIR, 'inferred-priorities.md');

/**
 * Daily-learn module — discoverable wrapper around the (skill +
 * workflow + output files) bundle that closes Jarvis's learning
 * loop.
 *
 * The whole point of this module: Jarvis should get smarter from
 * use, not from configuration. Today every preference is explicit
 * (priorities.md, module settings, mute lists). The daily-learn
 * loop watches WHAT YOU ACTUALLY DO — what you dismissed today,
 * which drafts you sent verbatim, which palette prompts you
 * repeated, which skills you escalated — and writes proposals you
 * can either accept manually OR have other skills read
 * automatically via the inferred-priorities.md file.
 *
 * It NEVER auto-applies a config change. The user is always in the
 * loop. But because inbox-curate + work-awareness read the
 * inferred file as supplemental input, the system gets sharper
 * over days even if the user never copies anything into their
 * explicit config.
 */
export const dailyLearnModule: Module = {
  id: 'daily-learn',
  name: 'Daily learn',
  description:
    'Meta-learning loop. Every weekday at 18:00, reads what you did today (dismissals, drafts accepted/discarded, task escalations, repeated prompts) and writes a daily journal + inferred-priorities.md. Consumed by inbox-curate + work-awareness so Jarvis gets sharper from use without manual configuration.',
  version: '1.0.0',
  memory: [
    {
      label: 'Daily journals',
      location: '~/.jarvis/learnings/<YYYY-MM-DD>.md',
      kind: 'directory',
      access: 'write',
      notes:
        'Human-readable end-of-day journal: what worked, what didn\'t, friction signals, next-day priorities. Append-only — scroll back to see how Jarvis thinks you work.',
    },
    {
      label: 'Inferred priorities (running)',
      location: '~/.jarvis/learnings/inferred-priorities.md',
      kind: 'file',
      access: 'read-write',
      notes:
        'Rewritten daily from rolling 14d window. Read by inbox-curate + work-awareness as supplemental input alongside your explicit priorities files (your manual config always wins). Decay rule: signals older than 14d drop out.',
    },
    {
      label: 'Workflow definition',
      location: '~/.jarvis/workflows/daily-learn-loop.json',
      kind: 'file',
      access: 'read',
      notes:
        'Cron: 0 18 * * 1-5 (18:00 weekdays). Default enabled — first-run lands a journal even when there\'s nothing to learn yet.',
    },
    {
      label: 'Skill body',
      location: '~/.jarvis/skills/daily-learn/SKILL.md',
      kind: 'file',
      access: 'read',
      notes: 'haiku-balanced tier. Reads activity feed + inbox dismissals + drafts + tasks + meetings + the user\'s explicit config files.',
    },
  ],
  intents: [
    {
      id: 'run-now',
      prefix: '/daily-learn',
      label: 'Run daily learn now',
      description:
        'Fire the meta-learning loop immediately instead of waiting for 18:00. Useful right after a heavy session when the signals are still fresh.',
      verbalTriggers: [
        'daily learn',
        'run daily learn',
        'learn from today',
        'what did you learn today',
        'what patterns do you see',
      ],
      handler: (_input, ctx) => {
        try {
          const run = ctx.runWorkflow(WORKFLOW_ID);
          ctx.notify(
            'Daily learn',
            'Reading today\'s signals — open ~/.jarvis/learnings/ in ~30s.',
          );
          return `Daily learn running · ${run.id.slice(0, 6)}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('not found') || msg.includes('unknown')) {
            return 'Workflow `daily-learn-loop` not installed. Reseed via app restart, or drop the JSON yourself.';
          }
          return `Couldn't fire: ${msg}`;
        }
      },
    },
    {
      id: 'open-learnings',
      prefix: '/learnings',
      label: 'Open learnings folder',
      description:
        'Reveal ~/.jarvis/learnings/ in Finder — daily journals + the running inferred-priorities.md file',
      verbalTriggers: [
        'open learnings',
        'show learnings',
        'show what Jarvis learned',
      ],
      handler: async () => {
        if (!existsSync(LEARNINGS_DIR)) {
          return `Nothing learned yet. The loop fires at 18:00 weekdays (or run /daily-learn now).`;
        }
        try {
          // If the inferred-priorities file exists, open the dir + reveal
          // that file specifically (most useful entry point).
          if (existsSync(INFERRED_FILE)) {
            shell.showItemInFolder(INFERRED_FILE);
          } else {
            const errMsg = await shell.openPath(LEARNINGS_DIR);
            if (errMsg) return `Couldn't open: ${errMsg}`;
          }
          return `Opened ${LEARNINGS_DIR}`;
        } catch (e) {
          return `Couldn't open: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
  ],
};
