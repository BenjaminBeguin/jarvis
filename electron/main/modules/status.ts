import type { Module } from './types.js';

/**
 * Tiny module that exposes `/status` (and `/next`) as palette shortcuts.
 * Both launch the same Jarvis-seeded `status` skill — which reads
 * ~/.jarvis/reminders.json, recent notes, recent meetings, and `gh pr
 * status` to produce a 'where am I' digest. The actual logic lives in
 * ~/.jarvis/skills/status/SKILL.md — this module is just the keyboard
 * shortcut.
 */
export const statusModule: Module = {
  id: 'status',
  name: 'Status',
  description: 'Quick "what is happening right now" digest via the status skill',
  version: '1.0.0',
  intents: [
    {
      id: 'status',
      prefix: '/status',
      label: 'Status digest',
      description: 'Pending reminders, recent notes/meetings, PRs',
      verbalTriggers: [
        'status',
        'what is happening',
        "what's happening",
        "what's up",
        'where am I',
      ],
      handler: (_input, ctx) => {
        const t = ctx.launchTask({
          prompt: 'Produce my status digest using the status skill.',
          skillId: 'status',
          origin: 'palette',
        });
        ctx.showHud(t.id);
        return `Working on it · #${t.id.slice(0, 6)}`;
      },
    },
    {
      id: 'next',
      prefix: '/next',
      label: 'What should I work on next?',
      description: 'Prioritized next-move recommendation',
      verbalTriggers: [
        'what should I work on next',
        'what should I do next',
        'what next',
      ],
      handler: (_input, ctx) => {
        const t = ctx.launchTask({
          prompt:
            "Run the status digest, then end with one extra paragraph: based on what's pending, what's the single best thing I should work on for the next 30 minutes, and why?",
          skillId: 'status',
          origin: 'palette',
        });
        ctx.showHud(t.id);
        return `Thinking · #${t.id.slice(0, 6)}`;
      },
    },
  ],
};
