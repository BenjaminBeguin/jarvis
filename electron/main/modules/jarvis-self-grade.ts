import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shell } from 'electron';

import type { Module } from './types.js';

const WORKFLOW_ID = 'jarvis-self-grade-loop';
const REPORT_DIR = join(
  homedir(),
  '.jarvis',
  'briefings',
  'jarvis-self-grade',
);

/**
 * Jarvis self-grade module — discoverable wrapper around the
 * `jarvis-self-grade` skill + `jarvis-self-grade-loop` workflow.
 *
 * The skill audits last week's drafts / workflows / escalations /
 * cost / chronic friction signals and writes a graded report. This
 * module just exposes a palette command to fire it on demand + a
 * shortcut to open the most recent report.
 *
 * Why this is a module instead of just a skill+workflow: discovering
 * "Jarvis is grading itself every Monday" is the point of the
 * feature. The palette command + the explicit Settings → Modules row
 * with declared memory makes it visible. Without the module wrapper
 * the user wouldn't know the report exists until they happened
 * across the briefings tab.
 */
export const jarvisSelfGradeModule: Module = {
  id: 'jarvis-self-grade',
  name: 'Jarvis self-grade',
  description:
    'Every Monday at 09:00, Jarvis audits its own outputs from the last 7 days (draft accept/discard, escalations, cost outliers, workflow health) and writes a graded report. Lands in the Briefings tab.',
  version: '1.0.0',
  memory: [
    {
      label: 'Weekly self-grade reports',
      location:
        '~/.jarvis/briefings/jarvis-self-grade/<YYYY-MM-DD>-week-<NN>.md',
      kind: 'directory',
      access: 'write',
      notes:
        "Markdown report — overall grade, sharp/dull skill lists with evidence, escalation tally, cost outliers, chronic friction, goal review. One file per ISO week (Monday). Surfaced in the Briefings tab.",
    },
    {
      label: 'Workflow definition',
      location: '~/.jarvis/workflows/jarvis-self-grade-loop.json',
      kind: 'file',
      access: 'read',
      notes:
        'Cron: 0 9 * * 1 (09:00 Monday). Default enabled — first Monday after install lands a "not enough data yet" report so the surface is discoverable.',
    },
    {
      label: 'Skill body',
      location: '~/.jarvis/skills/jarvis-self-grade/SKILL.md',
      kind: 'file',
      access: 'read',
      notes:
        "Balanced-tier skill. Reads drafts / workflow runs / task escalations / cost / daily learnings / goals via Jarvis MCP + sqlite. Cites counts, names skills, proposes concrete prompt/tier/cadence edits.",
    },
  ],
  intents: [
    {
      id: 'run-now',
      prefix: '/jarvis-grade',
      label: 'Run self-grade now',
      description:
        "Fire the weekly self-grade immediately instead of waiting for Monday 09:00. Useful when you want a fresh audit after a config change.",
      verbalTriggers: [
        'grade yourself',
        'jarvis self grade',
        'self grade',
        'audit yourself',
        'how are you doing',
      ],
      handler: (_input, ctx) => {
        try {
          const run = ctx.runWorkflow(WORKFLOW_ID);
          return `Self-grade running · #${run.id.slice(0, 6)}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('not found') || msg.includes('unknown')) {
            return 'Workflow `jarvis-self-grade-loop` not installed. Reseed via app restart, or drop the JSON yourself.';
          }
          return `Couldn't fire: ${msg}`;
        }
      },
    },
    {
      id: 'open',
      prefix: '/open-grade',
      label: 'Open latest self-grade',
      description:
        "Reveal the most recent self-grade markdown in Finder (or the folder if nothing's generated yet)",
      verbalTriggers: ['open grade', 'show grade', 'latest grade'],
      handler: async () => {
        if (!existsSync(REPORT_DIR)) {
          return 'No self-grade reports yet. Try /jarvis-grade to fire one now.';
        }
        try {
          const files = readdirSync(REPORT_DIR)
            .filter((f) => f.endsWith('.md'))
            .map((f) => ({
              name: f,
              path: join(REPORT_DIR, f),
              mtime: statSync(join(REPORT_DIR, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length === 0) {
            shell.showItemInFolder(REPORT_DIR);
            return 'No reports yet — opened the folder so you can verify.';
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
