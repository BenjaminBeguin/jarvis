import type { InboxItem } from '@shared/types';

import type { GoalStore } from '../goals.js';
import type { InboxSource } from '../inbox.js';

/**
 * Surface active goals into the unified Inbox so they triage
 * alongside PRs / Slack / meeting-actions / etc. Items carry a
 * fireAt = deadline so the time-pressured sort already in the
 * Inbox naturally floats imminent deadlines to the top.
 *
 * One item per active goal. Done / abandoned goals don't surface;
 * the user manages those via the dedicated palette intents.
 */
export function goalsInboxSource(goals: GoalStore): InboxSource {
  return {
    name: 'goals',
    label: 'Goals',
    async fetch(): Promise<InboxItem[]> {
      const active = goals.listActive();
      const now = Date.now();
      return active.map((g): InboxItem => {
        const daysLeft =
          g.deadline != null
            ? Math.max(0, Math.ceil((g.deadline - now) / (24 * 60 * 60 * 1000)))
            : null;
        const lastProgress =
          g.progressLog.length > 0
            ? g.progressLog[g.progressLog.length - 1]!
            : null;
        const sub =
          (daysLeft != null
            ? daysLeft === 0
              ? 'due today'
              : daysLeft === 1
                ? 'due tomorrow'
                : `${daysLeft}d left`
            : 'open-ended') +
          (lastProgress
            ? ` · last progress ${formatAgo(now - lastProgress.at)}`
            : ' · no progress yet');
        const item: InboxItem = {
          id: `goal-${g.id}`,
          source: 'goals',
          title: g.title,
          subtitle: sub,
          body: g.body,
          createdAt: g.createdAt,
          ...(g.deadline != null ? { fireAt: g.deadline } : {}),
          ...(g.project ? { project: g.project } : {}),
        };
        return item;
      });
    },
  };
}

function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
