import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — draft first-pass reviews for PRs requesting
 * the user's review where the author isn't on their team. Each draft
 * lands in the Drafts tab; Send submits the review via
 * `gh api /pulls/<num>/reviews`.
 *
 *   trigger:  autopilot · cron 15m (gated by appMode === 'autopilot')
 *   pipeline: shell(gh search prs --review-requested @me)
 *             → transform (parse + filter by authorAssociation)
 *             → run-skill (pr-review-triage returns JSON array)
 *             → transform (parse JSON)
 *             → draft-store-write (writes to ai_drafts table)
 *
 * The verdict (APPROVE / COMMENT / REQUEST_CHANGES) is baked into
 * each draft's sendAction.stdin. The user can change verdict only
 * by discarding + re-running — they can edit the summary body
 * freely. This is the right trade-off for the unified Drafts UI;
 * if you need finer-grained verdict editing, open the PR directly.
 *
 * Default `enabled: false`.
 */

const FILTER_FN = `(() => {
  const items = Array.isArray($) ? $ : [];
  // Filters applied:
  //   1. !isDraft     — drafts are still WIP; the author hasn't asked
  //                      for review yet, no point auto-drafting feedback.
  //   2. assoc filter — keep PRs where the author is NOT an OWNER /
  //                      MEMBER / COLLABORATOR of the repo (external
  //                      contributors). Edit the allowlist if your
  //                      team's GitHub-association shape differs.
  return items.filter(pr => {
    if (pr && pr.isDraft) return false;
    const assoc = String(pr.authorAssociation || '').toUpperCase();
    return assoc !== 'OWNER' && assoc !== 'MEMBER' && assoc !== 'COLLABORATOR';
  }).slice(0, 10);
})()`;

const AGENT_PROMPT = `You're given an array of pull requests requesting the user's review. Triage each one and produce a draft ready to submit — see your system prompt for the exact JSON shape (\`draft-store-write\` + shell sendAction with verdict baked into stdin).

Input PRs:
\`\`\`json
{prev}
\`\`\`

Past feedback the user has given on this scenario (match this tone / depth):
{feedback}

Output ONLY a JSON array of draft objects. No prose, no markdown fences.`;

const PARSE_FN = `(() => {
  try {
    const text = typeof $ === 'string' ? $ : '';
    const m = text.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`/);
    const json = m ? m[1] : text.trim();
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
})()`;

export const AUTOPILOT_PR_REVIEW_NON_TEAM_WORKFLOW: WorkflowDef = {
  id: 'autopilot-pr-review-non-team',
  name: 'Autopilot · Triage non-team PR reviews',
  description:
    'Every 15 min in autopilot mode, find PRs from non-team contributors requesting your review and draft a first-pass review for each. Drafts land in the Drafts tab — edit summary, refine via prompt, send (verdict baked in via gh api).',
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
          'number,title,url,repository,author,authorAssociation,updatedAt,isDraft',
          '--limit',
          '20',
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
      params: { skillId: 'pr-review-triage', prompt: AGENT_PROMPT },
    },
    {
      type: 'transform',
      params: { fn: PARSE_FN },
    },
    {
      type: 'draft-store-write',
      params: { source: 'pr-review-triage' },
    },
  ],
};
