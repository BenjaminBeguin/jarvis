import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';
import type { ProjectStore } from '../projects.js';

const execFileAsync = promisify(execFile);

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 15_000,
    env: { ...process.env, GH_PAGER: 'cat', PAGER: 'cat' },
  });
  return stdout;
}

/**
 * Single GraphQL fetch backing both PR inbox sources. One round-trip
 * gives us:
 *   - the viewer login (to check "did I reply to the last comment?")
 *   - PRs awaiting my review (with my reviews so we can filter out
 *     ones I've already submitted on)
 *   - my open PRs (with review threads so we can filter out ones
 *     where I've already replied / resolved)
 *
 * `repoFilter` (optional) constrains both queries to specific repos
 * via the gh search syntax. When empty / undefined, queries fall
 * back to the global default ("everything I have access to").
 *
 * The function is internal to this file; the two exported sources
 * each call it and pick the relevant slice. A 30s in-memory cache
 * dedupes back-to-back refreshes when both sources are registered.
 */

interface GhFetchResult {
  viewerLogin: string;
  needsReview: ReviewQueuePr[];
  myOpen: MyOpenPr[];
}

interface ReviewQueuePr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  /** Reviews I've submitted on this PR (filtered to current viewer
   * client-side via viewerLogin). */
  myReviewCount: number;
  /** GitHub `isDraft` — drafts are still WIP; the author hasn't
   *  asked for review yet. Filtered out of the review queue so we
   *  don't badger the user about half-finished PRs. */
  isDraft: boolean;
  /**
   * True when the viewer is requested individually (their user is
   * in `reviewRequests`), false when only their team is requested.
   * The Bridge surfaces only direct asks — team-level requests
   * tend to be passive ("if anyone has cycles") and would clutter
   * the focus queue. Power-users can still see team requests via
   * the underlying GitHub UI.
   */
  isDirectRequest: boolean;
}

interface MyOpenPr {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  repository: { nameWithOwner: string };
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  /** Unresolved threads where the last comment ISN'T me — i.e. waiting on me. */
  pendingThreads: number;
}

let cachedFetch: { at: number; repoFilterKey: string; result: GhFetchResult } | null = null;
const CACHE_TTL_MS = 30_000;

function repoSearchClause(repos: string[]): string {
  return repos.map((r) => `repo:${r}`).join(' ');
}

async function fetchGh(repoFilter: string[]): Promise<GhFetchResult> {
  const key = repoFilter.slice().sort().join(',');
  if (cachedFetch && cachedFetch.repoFilterKey === key && Date.now() - cachedFetch.at < CACHE_TTL_MS) {
    return cachedFetch.result;
  }

  const reviewQuery = ['review-requested:@me', 'is:pr', 'is:open']
    .concat(repoFilter.length ? [repoSearchClause(repoFilter)] : [])
    .join(' ');
  const mineQuery = ['author:@me', 'is:pr', 'is:open']
    .concat(repoFilter.length ? [repoSearchClause(repoFilter)] : [])
    .join(' ');

  // Two `search` blocks in one GraphQL query. Inline the search strings
  // because Vars don't propagate through SearchType without extra ceremony.
  // The viewer login comes back too for client-side "is this me" filtering.
  const query = `
    query {
      viewer { login }
      needsReview: search(first: 40, type: ISSUE, query: ${JSON.stringify(reviewQuery)}) {
        nodes {
          ... on PullRequest {
            number title url createdAt
            isDraft
            author { login }
            repository { nameWithOwner }
            reviews(first: 30) { nodes { author { login } } }
            reviewRequests(first: 30) {
              nodes {
                requestedReviewer {
                  __typename
                  ... on User { login }
                }
              }
            }
          }
        }
      }
      myOpen: search(first: 40, type: ISSUE, query: ${JSON.stringify(mineQuery)}) {
        nodes {
          ... on PullRequest {
            number title url updatedAt createdAt
            repository { nameWithOwner }
            reviewDecision
            reviewThreads(first: 50) {
              nodes {
                isResolved
                comments(last: 1) { nodes { author { login } } }
              }
            }
          }
        }
      }
    }
  `;

  const stdout = await runGh(['api', 'graphql', '-f', `query=${query}`]);
  const parsed = JSON.parse(stdout) as {
    data?: {
      viewer: { login: string };
      needsReview: { nodes: Array<{
        number: number; title: string; url: string; createdAt: string;
        isDraft: boolean;
        author: { login: string } | null;
        repository: { nameWithOwner: string };
        reviews: { nodes: Array<{ author: { login: string } | null }> };
        reviewRequests: {
          nodes: Array<{
            requestedReviewer:
              | { __typename: 'User'; login: string }
              | { __typename: string }
              | null;
          }>;
        };
      } | null> };
      myOpen: { nodes: Array<{
        number: number; title: string; url: string; updatedAt: string; createdAt: string;
        repository: { nameWithOwner: string };
        reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
        reviewThreads: { nodes: Array<{
          isResolved: boolean;
          comments: { nodes: Array<{ author: { login: string } | null }> };
        }> };
      } | null> };
    };
    errors?: unknown;
  };

  if (!parsed.data) {
    throw new Error('gh api graphql returned no data: ' + JSON.stringify(parsed.errors ?? parsed));
  }

  const viewerLogin = parsed.data.viewer.login;

  const needsReview: ReviewQueuePr[] = [];
  for (const n of parsed.data.needsReview.nodes) {
    if (!n) continue;
    const myReviewCount = n.reviews.nodes.filter(
      (r) => r.author?.login?.toLowerCase() === viewerLogin.toLowerCase(),
    ).length;
    const isDirectRequest = (n.reviewRequests?.nodes ?? []).some((rr) => {
      const reviewer = rr.requestedReviewer;
      if (!reviewer || reviewer.__typename !== 'User') return false;
      const login = (reviewer as { login?: string }).login;
      return (
        typeof login === 'string' &&
        login.toLowerCase() === viewerLogin.toLowerCase()
      );
    });
    needsReview.push({
      number: n.number,
      title: n.title,
      url: n.url,
      createdAt: n.createdAt,
      author: n.author,
      repository: n.repository,
      myReviewCount,
      isDraft: !!n.isDraft,
      isDirectRequest,
    });
  }

  const myOpen: MyOpenPr[] = [];
  for (const n of parsed.data.myOpen.nodes) {
    if (!n) continue;
    let pendingThreads = 0;
    for (const t of n.reviewThreads.nodes) {
      if (t.isResolved) continue;
      const last = t.comments.nodes[t.comments.nodes.length - 1];
      const lastAuthor = last?.author?.login;
      if (!lastAuthor) continue;
      // Pending if the most-recent commenter isn't me.
      if (lastAuthor.toLowerCase() !== viewerLogin.toLowerCase()) {
        pendingThreads++;
      }
    }
    myOpen.push({
      number: n.number,
      title: n.title,
      url: n.url,
      updatedAt: n.updatedAt,
      createdAt: n.createdAt,
      repository: n.repository,
      reviewDecision: n.reviewDecision,
      pendingThreads,
    });
  }

  const result: GhFetchResult = { viewerLogin, needsReview, myOpen };
  cachedFetch = { at: Date.now(), repoFilterKey: key, result };
  return result;
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
    if (normalizeRepo(p.repo).toLowerCase() === repoFullName.toLowerCase()) {
      return p.name;
    }
  }
  return undefined;
}

function normalizeRepo(repo: string): string {
  return repo
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * Collect the repo allowlist from tracked projects. If any project
 * has `inboxScan` explicitly true OR if any has `inboxScan` undefined
 * AND repo set, that repo gets scanned. Projects with `inboxScan:false`
 * are excluded.
 *
 * If NO project has a repo at all, returns an empty array → fall back
 * to scanning everything (no filter).
 */
function scanRepos(projects: ProjectStore | undefined): string[] {
  if (!projects) return [];
  const out: string[] = [];
  for (const p of projects.list()) {
    if (!p.repo) continue;
    if (p.inboxScan === false) continue;
    out.push(normalizeRepo(p.repo));
  }
  return out;
}

/**
 * PRs across all repos (or only configured ones) where review is
 * requested from the current user AND I haven't submitted a review
 * yet. Filters:
 *
 *   - `myReviewCount === 0` — I haven't already reviewed
 *   - `isDirectRequest` — I'm requested as a USER (not via a team).
 *     Team-only requests tend to be passive ("if anyone has cycles")
 *     and would clutter the Bridge focus queue. Direct requests
 *     mean someone specifically pinged me.
 *   - `!isDraft` — drafts are still WIP; the author hasn't actually
 *     asked for review yet. Surfacing them creates noise and pressure
 *     to review work that isn't ready.
 */
export function prReviewQueueInboxSource(projects?: ProjectStore): InboxSource {
  return {
    name: 'pr-review',
    label: 'PRs awaiting your review',
    async fetch(): Promise<InboxItem[]> {
      const { needsReview } = await fetchGh(scanRepos(projects));
      const now = Date.now();
      return needsReview
        .filter((pr) => pr.myReviewCount === 0)
        .filter((pr) => !pr.isDraft)
        .filter((pr) => pr.isDirectRequest)
        .map((pr) => {
          const repoLabel = pr.repository.nameWithOwner;
          return {
            id: `pr-review-${pr.url}`,
            source: 'pr-review',
            title: `#${pr.number} · ${pr.title}`,
            subtitle: `${repoLabel} · by @${pr.author?.login ?? '?'}`,
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
 * My open PRs where there's at least one unresolved review thread
 * whose last comment ISN'T me (i.e. waiting on me to respond) — OR
 * the PR has CHANGES_REQUESTED at the review level.
 *
 * Filters out PRs where I've already replied to / resolved every
 * thread, even if `gh pr list` would still show them as having
 * comments. The big accuracy upgrade.
 */
export function prAddressCommentsInboxSource(projects?: ProjectStore): InboxSource {
  return {
    name: 'pr-comments',
    label: 'Comments on your PRs',
    async fetch(): Promise<InboxItem[]> {
      const { myOpen } = await fetchGh(scanRepos(projects));
      const now = Date.now();
      return myOpen
        .filter(
          (pr) => pr.pendingThreads > 0 || pr.reviewDecision === 'CHANGES_REQUESTED',
        )
        .map((pr) => {
          const repoLabel = pr.repository.nameWithOwner;
          const sub: string[] = [repoLabel];
          if (pr.pendingThreads > 0) {
            sub.push(
              `${pr.pendingThreads} unresolved thread${pr.pendingThreads === 1 ? '' : 's'}`,
            );
          }
          if (pr.reviewDecision === 'CHANGES_REQUESTED') {
            sub.push('changes requested');
          }
          return {
            id: `pr-comments-${pr.url}`,
            source: 'pr-comments',
            title: `#${pr.number} · ${pr.title}`,
            subtitle: sub.join(' · '),
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
