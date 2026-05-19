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

const AGENT_PROMPT = `Review this pull request as a senior engineer would. Output a draft review (one paragraph summary + bullet-list of inline concerns). Cite specific files and line ranges. Aim for accurate over comprehensive.

PR data:
{prev}

Past feedback the user has given you on this scenario — match this tone / style:
{feedback}

Output ONLY the review markdown. Do not address the user. The user will read your output verbatim and decide whether to post it.`;

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
        command: 'gh',
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
        source: 'autopilot-drafts',
      },
    },
  ],
};
