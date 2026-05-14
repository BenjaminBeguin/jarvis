import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';

const execFileAsync = promisify(execFile);

interface GhPr {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  headRepositoryOwner?: { login: string };
  headRepository?: { name: string };
  createdAt: string;
  updatedAt?: string;
  comments?: number;
  reviewDecision?: string;
}

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 12_000,
    // Avoid `gh` paging into less when invoked under Electron — would hang.
    env: { ...process.env, GH_PAGER: 'cat', PAGER: 'cat' },
  });
  return stdout;
}

/**
 * PRs across all repos where review is requested from the current user.
 * Powers the "you have N reviews to do" headline of the inbox. Each row
 * has a 1-click action that fires the `pr-review-queue` skill scoped to
 * that PR (it'll pull the diff, draft a review, ask for confirmation).
 *
 * Skipped gracefully if `gh` isn't installed or the user isn't logged in.
 */
export const prReviewQueueInboxSource: InboxSource = {
  name: 'pr-review',
  label: 'PRs awaiting your review',
  async fetch(): Promise<InboxItem[]> {
    const stdout = await runGh([
      'pr',
      'list',
      '--search',
      'review-requested:@me is:open',
      '--state',
      'open',
      '--limit',
      '40',
      '--json',
      'number,title,url,author,headRepositoryOwner,headRepository,createdAt',
    ]);
    const prs = JSON.parse(stdout) as GhPr[];
    const now = Date.now();
    return prs.map((pr) => {
      const owner = pr.headRepositoryOwner?.login ?? '';
      const repo = pr.headRepository?.name ?? '';
      const repoLabel = owner && repo ? `${owner}/${repo}` : '';
      return {
        id: `pr-review-${pr.url}`,
        source: 'pr-review',
        title: `#${pr.number} · ${pr.title}`,
        subtitle: `${repoLabel ? `${repoLabel} · ` : ''}by @${pr.author.login}`,
        url: pr.url,
        createdAt: pr.createdAt ? Date.parse(pr.createdAt) : now,
        action: {
          label: 'Review now',
          skillId: 'pr-review-queue',
          prompt: `Review PR ${pr.url}`,
        },
      };
    });
  },
};

/**
 * The user's own open PRs that have new review comments. Surfaces them
 * for the `pr-address-comments` skill, which rebases + works the comments
 * down to zero. We can't cheaply tell "new since I last looked" from `gh`
 * alone, so we show every open PR of mine that has at least one comment;
 * the user filters by what they care about visually.
 */
export const prAddressCommentsInboxSource: InboxSource = {
  name: 'pr-comments',
  label: 'Comments on your PRs',
  async fetch(): Promise<InboxItem[]> {
    const stdout = await runGh([
      'pr',
      'list',
      '--author',
      '@me',
      '--state',
      'open',
      '--limit',
      '40',
      '--json',
      'number,title,url,author,headRepositoryOwner,headRepository,updatedAt,comments,reviewDecision',
    ]);
    const prs = JSON.parse(stdout) as GhPr[];
    const now = Date.now();
    return prs
      .filter((pr) => (pr.comments ?? 0) > 0 || pr.reviewDecision === 'CHANGES_REQUESTED')
      .map((pr) => {
        const owner = pr.headRepositoryOwner?.login ?? '';
        const repo = pr.headRepository?.name ?? '';
        const repoLabel = owner && repo ? `${owner}/${repo}` : '';
        const decision =
          pr.reviewDecision === 'CHANGES_REQUESTED'
            ? 'changes requested'
            : pr.reviewDecision === 'APPROVED'
              ? 'approved'
              : pr.comments
                ? `${pr.comments} comment${pr.comments === 1 ? '' : 's'}`
                : '';
        return {
          id: `pr-comments-${pr.url}`,
          source: 'pr-comments',
          title: `#${pr.number} · ${pr.title}`,
          subtitle: `${repoLabel ? `${repoLabel} · ` : ''}${decision}`,
          url: pr.url,
          createdAt: pr.updatedAt ? Date.parse(pr.updatedAt) : now,
          action: {
            label: 'Address comments',
            skillId: 'pr-address-comments',
            prompt: `Address review comments on ${pr.url}`,
          },
        };
      });
  },
};
