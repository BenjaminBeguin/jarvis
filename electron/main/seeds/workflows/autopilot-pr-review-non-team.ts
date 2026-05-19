import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — first-pass review for PRs that request your
 * review from outside your team.
 *
 *   trigger:  autopilot · cron 15m  (gated by appMode === 'autopilot')
 *   pipeline: shell(gh) → transform → run-skill → draft-output
 *
 * Why a cron + filter shape:
 *   - gh search is cheap; the agent only spins up when there's
 *     actually a non-team PR review pending. Saves Claude turns.
 *   - The agent gets {prev} as the matched PR list AND {feedback}
 *     pulled from ~/.jarvis/autopilot/feedback/autopilot-pr-review-
 *     non-team.md — so its tone calibrates over time as the user
 *     accepts / edits / rejects past drafts.
 *
 * The output is a *draft* — it lands in the Autopilot drafts Inbox
 * section. To make this auto-post the review, replace the last
 * `draft-output` node with a `prompt-output → shell (gh pr review
 * --body …)` chain. Seed ships in draft mode so users opt in to
 * sending explicitly.
 *
 * Customization:
 *   - Edit the transform `fn` to set what counts as "your team". The
 *     default filter is `authorAssociation` ∈ { CONTRIBUTOR, FIRST_TIME_
 *     CONTRIBUTOR, NONE } — i.e. not OWNER/MEMBER. Swap to a hardcoded
 *     team-handle check if you want sharper boundaries.
 *   - `enabled: false` by default. Flip to true from Settings →
 *     Workflows once you've verified the connector lookup works.
 */

const FILTER_FN = `(() => {
  const items = Array.isArray($) ? $ : [];
  // Keep only PRs where the author is not an OWNER/MEMBER of the
  // repo. Adjust to your team's actual GitHub-team handle if you
  // want a sharper boundary.
  const external = items.filter((pr) => {
    const assoc = (pr.authorAssociation || '').toUpperCase();
    return assoc !== 'OWNER' && assoc !== 'MEMBER' && assoc !== 'COLLABORATOR';
  });
  if (external.length === 0) return null;
  // Pick the oldest unreviewed — agent works through the queue one
  // PR per tick. Subsequent ticks pick up the next one.
  external.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  return external[0];
})()`;

const AGENT_PROMPT = `Review this pull request as a senior engineer would. Draft (don't post) a review.

**Do NOT use gh pr review, gh pr comment, or any other gh write
command.** The user reviews your draft in the Jarvis Inbox and
posts manually if they want. Read-only gh commands (gh pr view,
gh pr diff) are fine for gathering context.

Output a single markdown block:
  - One-paragraph summary of the change.
  - Bullet list of inline concerns, each citing file:line.

Be accurate over comprehensive — a confident "looks good" beats a
manufactured nit. If nothing actually breaks, say so.

PR to review:
{prev}

Past feedback the user has given you on this scenario — match
this tone / style:
{feedback}

Output ONLY the review markdown. No greeting, no signoff, no
explanation to the user — they read your output verbatim.`;

export const AUTOPILOT_PR_REVIEW_NON_TEAM_WORKFLOW: WorkflowDef = {
  id: 'autopilot-pr-review-non-team',
  name: 'Autopilot · PR review (non-team)',
  description:
    'Every 15 min in autopilot mode, find a PR awaiting your review whose author is outside your team, draft a first-pass review, and drop it in the Autopilot drafts inbox.',
  enabled: false,
  trigger: { kind: 'autopilot', when: 'cron', every: '15m' },
  pipeline: [
    {
      type: 'shell',
      params: {
        cmd: 'gh',
        args: [
          'search',
          'prs',
          '--review-requested',
          '@me',
          '--state',
          'open',
          '--json',
          'number,title,url,repository,author,authorAssociation,updatedAt',
          '--limit',
          '30',
        ],
        timeoutMs: 30_000,
      },
    },
    {
      type: 'transform',
      params: {
        fn: `(() => { try { return JSON.parse(typeof $ === 'string' ? $ : '[]'); } catch { return []; } })()`,
      },
    },
    {
      type: 'transform',
      params: { fn: FILTER_FN },
    },
    {
      type: 'run-skill',
      params: { skillId: 'pr-review-queue', prompt: AGENT_PROMPT },
    },
    {
      type: 'draft-output',
      params: {
        title: 'Autopilot · PR review draft',
        // Snippet of the draft inline so the user gets a preview
        // without having to expand every row.
        subtitle: '{prev}',
        source: 'autopilot-drafts',
      },
    },
  ],
};
