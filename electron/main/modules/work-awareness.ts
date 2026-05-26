import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shell } from 'electron';

import type { Module } from './types.js';

const WORKFLOW_ID = 'work-awareness-loop';
const CALIBRATE_SKILL_ID = 'work-awareness-calibrate';
const PRIORITIES_FILE = join(
  homedir(),
  '.jarvis',
  'work-awareness-priorities.md',
);

/**
 * Work-awareness module — discoverable wrapper around the ambient
 * watcher (skill + workflow + inbox source).
 *
 * The structured config lives HERE in `settings` (rendered as the
 * Settings → Modules → Work awareness panel). The skill reads those
 * settings out of `config.json` on every tick — that's why the
 * settings UI is the primary surface. The companion priorities
 * markdown is now an optional freeform supplement for the nuance the
 * structured fields can't capture (the user's notion of what
 * "urgent" looks like, edge-case rules, etc.).
 *
 * Smart inference happens at SKILL RUN time, not at settings save
 * time. The agent always uses recent activity (Slack mentions, PR
 * reviews, meeting attendees) — the settings just add explicit
 * inputs ON TOP. `autoDetectPeople` toggles whether the implicit
 * list is merged in.
 *
 * Palette intents:
 *   /work-awareness            — fire the workflow now
 *   /work-awareness-edit       — open the priorities md in editor
 *   /work-awareness-calibrate  — run the calibrate skill, which
 *                                scans recent activity + proposes
 *                                people / channels to add
 */
export const workAwarenessModule: Module = {
  id: 'work-awareness',
  name: 'Work awareness',
  description:
    'Ambient watcher — every 30 min during working hours, synthesises recent signal across Slack / GitHub / Linear / Notion / meetings / notes into a "your attention" inbox section, and auto-dismisses items it can see you already handled.',
  version: '1.1.0',
  settings: {
    description: [
      'Tune the ambient watcher. The skill reads these settings on',
      'every 30-min tick + uses recent activity for inference on top.',
      '',
      'Comma-separate names / handles / channels. Leave a field empty',
      'to rely entirely on auto-detected signals.',
    ].join('\n'),
    fields: [
      {
        key: 'priorityPeople',
        label: 'People who matter (always surface their threads)',
        hint: 'Comma-separated Slack handles, emails, GitHub usernames. e.g. "@theo, luca@hive.app, ben-bot". These are ALWAYS surfaced — auto-detection adds more on top when enabled below.',
        type: 'text',
        default: '',
      },
      {
        key: 'priorityChannels',
        label: 'Channels that matter',
        hint: 'Comma-separated Slack channels. e.g. "#squad-mx, #incidents". Mentions / new threads here jump in even off-hours.',
        type: 'text',
        default: '',
      },
      {
        key: 'muteChannels',
        label: 'Channels / patterns to mute',
        hint: 'Comma-separated. Items matching these get dropped. e.g. "#random, #announcements, #memes, lgtm comments".',
        type: 'text',
        default: '#random, #announcements, #memes',
      },
      {
        key: 'autoDetectPeople',
        label: 'Auto-detect people from activity',
        hint: 'When ON, the agent also considers people who tagged you, replied to you, or reviewed your PRs in the past 2 weeks — alongside the explicit list above. Turn off if the auto-detection surfaces too many.',
        type: 'boolean',
        default: true,
      },
      {
        key: 'autoDismiss',
        label: 'Auto-dismiss things I already handled',
        hint: 'When ON, the agent drops inbox items where it can see you completed the underlying action (PR merged, Slack reply sent, etc.). Soft 8h snooze — wrong dismissals naturally reappear later.',
        type: 'boolean',
        default: true,
      },
      {
        key: 'dismissalConfidence',
        label: 'Auto-dismiss confidence',
        hint: 'How sure the agent must be before dismissing. Conservative = only obvious matches. Aggressive = fuzzy matches OK (more recall, more false positives).',
        type: 'select',
        default: 'balanced',
        options: [
          { value: 'conservative', label: 'Conservative — exact matches only' },
          { value: 'balanced', label: 'Balanced (default)' },
          { value: 'aggressive', label: 'Aggressive — fuzzy matches OK' },
        ],
      },
      {
        key: 'maxItems',
        label: 'Max items to surface per tick',
        hint: 'Cap on the "your attention" section. Smaller = sharper, larger = more recall. Default 8.',
        type: 'number',
        default: 8,
        min: 3,
        max: 20,
        step: 1,
      },
    ],
  },
  memory: [
    {
      label: 'Structured settings (primary)',
      location: 'config.json · moduleSettings.work-awareness',
      kind: 'config',
      access: 'read-write',
      notes:
        'People / channels / mute / confidence / cadence. Edit via Settings → Modules → Work awareness. Skill reads these on every tick.',
    },
    {
      label: 'Calibration markdown (freeform supplement)',
      location: '~/.jarvis/work-awareness-priorities.md',
      kind: 'file',
      access: 'read-write',
      notes:
        'Optional. For nuance the structured settings can\'t capture — your definition of "urgent", edge-case rules, running calibration notes. Skill reads this alongside the settings.',
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
        'Cron: */30 {businessHours}. Default disabled — toggle on in Settings → Workflows after filling in settings.',
    },
    {
      label: 'Output inbox feed',
      location: '~/.jarvis/inbox/work-awareness.json',
      kind: 'file',
      access: 'write',
      notes:
        'Written by the skill. Wrapper carries items[] (surface) + dismissals[] (8h soft-snooze applied automatically by userInboxSource).',
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
        'what is waiting on me',
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
      label: 'Edit awareness priorities (markdown)',
      description:
        'Open ~/.jarvis/work-awareness-priorities.md for freeform supplemental notes (the structured config lives in Settings → Modules)',
      verbalTriggers: [
        'edit work awareness',
        'edit awareness priorities',
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
    {
      id: 'calibrate',
      prefix: '/work-awareness-calibrate',
      label: 'Calibrate from recent activity',
      description:
        'Scan recent activity across connected MCPs (Slack, GitHub, Linear) and propose people + channels to add to the priority lists',
      verbalTriggers: [
        'calibrate work awareness',
        'who matters at work',
        'discover priority people',
      ],
      handler: (_input, ctx) => {
        const t = ctx.launchTask({
          prompt:
            'Run the work-awareness calibration pass per your system prompt. Output proposed additions to the priority people + channels lists, plus suggested mutes, in a short bullet list the user can copy into Settings → Modules → Work awareness.',
          skillId: CALIBRATE_SKILL_ID,
          origin: 'palette',
        });
        ctx.showHud(t.id);
        return `Calibrating · #${t.id.slice(0, 6)}`;
      },
    },
  ],
};
