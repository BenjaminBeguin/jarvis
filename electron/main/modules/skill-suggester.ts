import type { Module } from './types.js';

const MAX_RECENT = 80;

/**
 * Periodically (or on demand via /suggest-skills) feed recent prompts to the
 * skill-author Claude skill and let it propose new reusable skills. The
 * actual analysis lives in the SKILL.md — this module just gathers the
 * input and pops a HUD for the user to watch the analysis run. The
 * skill-author writes its output to ~/.jarvis/.skill-batch.json which the
 * SkillSuggestionStore (owned in main/index.ts) ingests automatically.
 */
export const skillSuggesterModule: Module = {
  id: 'skill-suggester',
  name: 'Skill suggester',
  description:
    'Watches your recent prompts and proposes reusable skills you can accept with one click',
  version: '1.0.0',
  intents: [
    {
      id: 'suggest-skills',
      prefix: '/suggest-skills',
      label: 'Analyze prompts for skill ideas',
      description:
        'Send recent prompts to Claude to find reusable patterns worth saving as skills',
      verbalTriggers: [
        'suggest skills',
        'suggest new skills',
        'find skill ideas',
        'analyze my prompts',
      ],
      handler: (_input, ctx) => {
        // Visible "I ran" beacon — if the user sees this fire but nothing
        // else, we know the handler started but failed downstream.
        ctx.notify('Skill suggester', 'starting analysis…');
        const recent = ctx.listRecentTasks(MAX_RECENT);
        // Filter to Jarvis-owned tasks with a real prompt. External
        // claude-code sessions get noisy, skip them.
        const prompts = recent
          .filter(
            (t) =>
              t.origin !== 'external' &&
              typeof t.inputPreview === 'string' &&
              t.inputPreview.trim().length > 0,
          )
          .map((t) => t.inputPreview.replace(/\s+/g, ' ').trim())
          .filter((p) => p.length > 0);

        if (prompts.length === 0) {
          // Visible feedback — the palette swallows success-string returns,
          // so a notification is the only way the user sees this.
          ctx.notify(
            'Skill suggester',
            'No Jarvis-owned prompts yet. Ask Jarvis a few things first.',
          );
          return 'No prompts to analyze yet.';
        }

        const numbered = prompts
          .slice(0, MAX_RECENT)
          .map((p, i) => `${i + 1}. ${p}`)
          .join('\n');

        const t = ctx.launchTask({
          prompt:
            `Analyze these recent prompts (newest first) and propose reusable skills following the skill-author skill's instructions. Write the JSON batch to ~/.jarvis/.skill-batch.json.\n\n${numbered}`,
          skillId: 'skill-author',
          origin: 'palette',
        });
        ctx.showHud(t.id);
        // Belt-and-suspenders: pop a quick notification too in case the HUD
        // ends up hidden behind another app while the user looks for it.
        ctx.notify(
          'Skill suggester',
          `Analyzing ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} — opening HUD`,
        );
        return `Analyzing ${prompts.length} prompts · #${t.id.slice(0, 6)}`;
      },
    },
  ],
};
