import type { Module } from './types.js';

/**
 * Two high-value PR workflows wrapped as palette intents:
 *
 *   /review-prs  — walk through PRs assigned to me, structured review
 *                  per PR with plan-first → confirm → post.
 *   /address-pr  — pick one of my open PRs, rebase from main, walk
 *                  through review comments, fix each, reply, commit,
 *                  push.
 *
 * Both lean entirely on Claude + `gh` for the real work. The module
 * is thin glue — just builds the prompt + launches the skill.
 */
export const prWorkflowsModule: Module = {
  id: 'pr-workflows',
  name: 'PR workflows',
  description:
    'Review queued PRs in batch, or address review comments on your own open PRs end-to-end',
  version: '1.0.0',
  intents: [
    {
      id: 'review-prs',
      prefix: '/review-prs',
      label: 'Review my queued PRs',
      description: 'Structured review of every PR awaiting your review',
      placeholder: 'Optional emphasis (e.g. "focus on tests")',
      verbalTriggers: [
        'review my prs',
        'review the prs',
        'review my pull requests',
        'review pull requests',
        'review queue',
        'pr review queue',
        'clear my pr queue',
      ],
      handler: (input, ctx) => {
        const focus = input.trim();
        const prompt = focus
          ? `Walk my PR review queue. Carry this focus across every PR: ${focus}`
          : 'Walk my PR review queue using the skill defaults.';
        const t = ctx.launchTask({
          prompt,
          skillId: 'pr-review-queue',
          origin: 'palette',
        });
        ctx.showHud(t.id);
        return `Pulling your review queue · #${t.id.slice(0, 6)}`;
      },
    },
    {
      id: 'address-pr',
      prefix: '/address-pr',
      label: 'Address comments on my PR',
      description: 'Rebase, fix every review comment, reply, push',
      placeholder: 'PR number / URL · or leave blank to pick',
      verbalTriggers: [
        'address comments on pr',
        'address pr comments',
        'fix pr comments',
        'address my pr',
        'handle pr comments',
        'address my pr comments',
      ],
      handler: (input, ctx) => {
        const arg = input.trim();
        const prompt = arg
          ? `Work the review comments on this PR: ${arg}`
          : 'Look at my open PRs and ask which one to address.';
        const t = ctx.launchTask({
          prompt,
          skillId: 'pr-address-comments',
          origin: 'palette',
        });
        ctx.showHud(t.id);
        return `Working PR comments · #${t.id.slice(0, 6)}`;
      },
    },
  ],
};
