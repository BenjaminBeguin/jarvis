import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';
import type { ProjectStore } from '../projects.js';

const execFileAsync = promisify(execFile);

interface GhPr {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  // `gh search prs` returns repository.nameWithOwner (a global query
  // works across all repos, no local clone needed). `gh pr list` would
  // surface headRepositoryOwner + headRepository — but it requires a
  // git remote in the cwd, which Jarvis doesn't have. Search > list.
  repository?: { nameWithOwner: string };
  createdAt: string;
  updatedAt?: string;
  commentsCount?: number;
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
 * Map a repo identifier ("owner/name") back to a tracked project name,
 * so PR inbox items get a `project` tag and the scope filter in the
 * Inbox UI works for them. Returns undefined if no match.
 */
function matchProjectByRepo(
  projects: ProjectStore | undefined,
  repoFullName: string,
): string | undefined {
  if (!projects || !repoFullName) return undefined;
  for (const p of projects.list()) {
    if (!p.repo) continue;
    // ProjectDef.repo can be "owner/name" or "github.com/owner/name" or
    // a full URL. Normalise to owner/name for comparison.
    const norm = p.repo
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/^github\.com\//i, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    if (norm.toLowerCase() === repoFullName.toLowerCase()) return p.name;
  }
  return undefined;
}

/**
 * PRs across all repos where review is requested from the current user.
 * Powers the "you have N reviews to do" headline of the inbox. Each row
 * has a 1-click action that fires the `pr-review-queue` skill scoped to
 * that PR (it'll pull the diff, draft a review, ask for confirmation).
 *
 * Uses `gh search prs` (not `gh pr list`) — the search subcommand works
 * globally across every repo you have access to, no local clone needed.
 * Skipped gracefully if `gh` isn't installed or the user isn't logged in.
 *
 * Takes a ProjectStore so each item gets tagged with `project: <name>`
 * when the PR's repo matches a tracked project — drives scope filtering
 * in the Inbox UI.
 */
export function prReviewQueueInboxSource(projects?: ProjectStore): InboxSource {
  return {
    name: 'pr-review',
    label: 'PRs awaiting your review',
    async fetch(): Promise<InboxItem[]> {
      const stdout = await runGh([
        'search',
        'prs',
        '--review-requested',
        '@me',
        '--state',
        'open',
        '--limit',
        '40',
        '--json',
        'number,title,url,author,repository,createdAt',
      ]);
      const prs = JSON.parse(stdout) as GhPr[];
      const now = Date.now();
      return prs.map((pr) => {
        const repoLabel = pr.repository?.nameWithOwner ?? '';
        return {
          id: `pr-review-${pr.url}`,
          source: 'pr-review',
          title: `#${pr.number} · ${pr.title}`,
          subtitle: `${repoLabel ? `${repoLabel} · ` : ''}by @${pr.author.login}`,
          url: pr.url,
          createdAt: pr.createdAt ? Date.parse(pr.createdAt) : now,
          project: matchProjectByRepo(projects, repoLabel),
          action: {
            label: 'Review now',
            skillId: 'pr-review-queue',
            prompt: `Review PR ${pr.url}`,
          },
        };
      });
    },
  };
}

/**
 * The user's own open PRs that have review comments. Surfaces them for
 * the `pr-address-comments` skill, which rebases + works the comments
 * down to zero. Again `gh search prs` — works globally without a local
 * remote.
 */
export function prAddressCommentsInboxSource(projects?: ProjectStore): InboxSource {
  return {
    name: 'pr-comments',
    label: 'Comments on your PRs',
    async fetch(): Promise<InboxItem[]> {
      const stdout = await runGh([
        'search',
        'prs',
        '--author',
        '@me',
        '--state',
        'open',
        '--limit',
        '40',
        // `gh search prs` doesn't expose reviewDecision/comments — those
        // are list-only. We surface every open PR of mine; the user can
        // visually skip ones they know are already addressed. Better that
        // than an empty inbox section.
        '--json',
        'number,title,url,author,repository,createdAt,updatedAt',
      ]);
      const prs = JSON.parse(stdout) as GhPr[];
      const now = Date.now();
      return prs.map((pr) => {
        const repoLabel = pr.repository?.nameWithOwner ?? '';
        return {
          id: `pr-comments-${pr.url}`,
          source: 'pr-comments',
          title: `#${pr.number} · ${pr.title}`,
          subtitle: `${repoLabel ? `${repoLabel} · ` : ''}your PR · open`,
          url: pr.url,
          createdAt: pr.updatedAt ? Date.parse(pr.updatedAt) : now,
          project: matchProjectByRepo(projects, repoLabel),
          action: {
            label: 'Address comments',
            skillId: 'pr-address-comments',
            prompt: `Address review comments on ${pr.url}`,
          },
        };
      });
    },
  };
}
