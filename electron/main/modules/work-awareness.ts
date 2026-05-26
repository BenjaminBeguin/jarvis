import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shell } from 'electron';

import type { Module } from './types.js';

const WORKFLOW_ID = 'work-awareness-loop';
const PRIORITIES_FILE = join(
  homedir(),
  '.jarvis',
  'work-awareness-priorities.md',
);

/**
 * Work-awareness module — discoverable wrapper around the (skill +
 * workflow + calibration file + inbox source) bundle that drives
 * Jarvis's ambient open-loop watcher.
 *
 * The module doesn't OWN the loop — the workflow does the scheduling,
 * the skill does the synthesis, the userInboxSource consumes the
 * output JSON + dismissals. The module exists to:
 *
 *   - **Declare memory** so Settings → Modules → Work awareness
 *     surfaces the four storage locations the loop touches.
 *   - **Expose palette intents**: `/work-awareness` fires the
 *     workflow now (don't wait 30 min), `/work-awareness-edit`
 *     opens the priorities file in the user's default editor.
 *   - **Provide a discoverable tile** in Settings → Modules so the
 *     user can find + understand the feature without grepping.
 *
 * See [docs/work-awareness.md](../../docs/work-awareness.md) for the
 * full architecture + first-run setup.
 */
export const workAwarenessModule: Module = {
  id: 'work-awareness',
  name: 'Work awareness',
  description:
    'Ambient watcher — every 30 min during working hours, synthesises recent signal across Slack / GitHub / Linear / Notion / meetings / notes into a "your attention" inbox section, and auto-dismisses items it can see you already handled.',
  version: '1.0.0',
  memory: [
    {
      label: 'Calibration file',
      location: '~/.jarvis/work-awareness-priorities.md',
      kind: 'file',
      access: 'read-write',
      notes:
        'Shapes the watcher\'s lens: people who matter, what to mute, what counts as "done" for auto-dismissal. The skill reads it on every tick.',
    },
    {
      label: 'Skill body',
      location: '~/.jarvis/skills/work-awareness/SKILL.md',
      kind: 'file',
      access: 'read',
      notes:
        'haiku-4-5 by default. Bump the model in frontmatter for sharper synthesis at higher cost.',
    },
    {
      label: 'Workflow definition',
      location: '~/.jarvis/workflows/work-awareness-loop.json',
      kind: 'file',
      access: 'read',
      notes:
        'Cron: */30 {businessHours}. Default disabled — toggle on in Settings → Workflows after editing the priorities file.',
    },
    {
      label: 'Output inbox feed',
      location: '~/.jarvis/inbox/work-awareness.json',
      kind: 'file',
      access: 'write',
      notes:
        'Written by the skill via the Write tool. Wrapper carries `items[]` (surface) AND `dismissals[]` (8h soft-snooze applied automatically by userInboxSource).',
    },
  ],
  intents: [
    {
      id: 'run-now',
      prefix: '/work-awareness',
      label: 'Run work awareness now',
      description:
        'Fire the work-awareness loop immediately instead of waiting for the next 30-min tick',
      verbalTriggers: [
        'work awareness',
        'run work awareness',
        'check open loops',
        'what should I look at',
        'what am I forgetting',
      ],
      handler: (_input, ctx) => {
        try {
          const run = ctx.runWorkflow(WORKFLOW_ID);
          ctx.notify(
            'Work awareness',
            'Scanning recent signal — open the Inbox in ~30s.',
          );
          return `Work awareness running · ${run.id.slice(0, 6)}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('not found') || msg.includes('unknown')) {
            return 'Workflow `work-awareness-loop` not installed. Reseed via app restart, or drop the JSON yourself.';
          }
          return `Couldn't fire: ${msg}`;
        }
      },
    },
    {
      id: 'edit',
      prefix: '/work-awareness-edit',
      label: 'Edit awareness priorities',
      description:
        'Open ~/.jarvis/work-awareness-priorities.md in your default editor',
      verbalTriggers: [
        'edit work awareness',
        'edit awareness priorities',
        'work awareness settings',
        'tune work awareness',
      ],
      handler: async () => {
        if (!existsSync(PRIORITIES_FILE)) {
          return `Priorities file missing — expected at ${PRIORITIES_FILE}. Reseed or create it manually.`;
        }
        try {
          const err = await shell.openPath(PRIORITIES_FILE);
          if (err) return `Couldn't open: ${err}`;
          return `Opened ${PRIORITIES_FILE}`;
        } catch (e) {
          return `Couldn't open: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
  ],
};
