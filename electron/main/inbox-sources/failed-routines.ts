import type { InboxItem, TaskSummary } from '@shared/types';

import { listRecentTasks } from '../db.js';
import type { InboxSource } from '../inbox.js';

/**
 * Recently-errored Jarvis tasks worth a second look. We focus on routines
 * specifically (rather than every errored task) because palette tasks the
 * user already saw error live — they don't need a second surface for
 * them. A routine that fired overnight + errored is what actually slips
 * through the cracks.
 *
 * Scope: errored routine tasks from the last 24h, **deduplicated by
 * skill**. A routine that fires every 10 min and breaks would otherwise
 * produce dozens of inbox rows for the same problem — instead we show
 * one row per skill with the consecutive-failure streak as subtitle
 * context, so 3 failures in a row reads as one urgent item, not 3.
 */
export function failedRoutinesInboxSource(): InboxSource {
  return {
    name: 'failed-routines',
    label: 'Needs attention',
    async fetch(): Promise<InboxItem[]> {
      const horizon = Date.now() - 24 * 60 * 60 * 1000;
      // Look back further than 24h for streak detection — a routine
      // failing every day for 3 days is a stronger signal than one
      // hitting an error overnight. Cap at 200 tasks so the SQLite hit
      // stays bounded.
      const recent = listRecentTasks(200);
      const routineTasks = recent.filter((t) => t.origin === 'routine');

      // Group by skillId so we can count consecutive failures per
      // routine. Tasks with no skillId (manual routine fires?) get
      // bucketed under their own id — they don't need streak detection.
      const bySkill = new Map<string, TaskSummary[]>();
      for (const t of routineTasks) {
        const key = t.skillId ?? `__unkeyed-${t.id}`;
        if (!bySkill.has(key)) bySkill.set(key, []);
        bySkill.get(key)!.push(t);
      }

      const items: InboxItem[] = [];
      for (const [skillId, tasks] of bySkill) {
        // Tasks are already sorted DESC by startedAt from the query.
        // Skip skills where the most recent run succeeded — they're not
        // currently broken.
        const mostRecent = tasks[0];
        if (!mostRecent || mostRecent.status !== 'errored') continue;
        // Only surface if the most recent error is within the 24h
        // window — otherwise we'd nag about a routine the user already
        // saw / triaged days ago.
        if (mostRecent.startedAt < horizon) continue;

        // Count consecutive failures from the head — stop at the first
        // non-errored run. This counts a "streak" of failures back as
        // far as the look-back window permits.
        let streak = 0;
        for (const t of tasks) {
          if (t.status === 'errored') streak += 1;
          else break;
        }

        const skillLabel = skillId.startsWith('__unkeyed-') ? '' : ` · ${skillId}`;
        const streakLabel =
          streak >= 2 ? ` · ${streak} in a row` : '';
        items.push({
          id: `failed-${mostRecent.id}`,
          source: 'failed-routines',
          title: mostRecent.title,
          subtitle: `Routine failed${skillLabel}${streakLabel}`,
          createdAt: mostRecent.endedAt ?? mostRecent.startedAt,
          action: {
            label: 'Retry',
            ...(mostRecent.skillId ? { skillId: mostRecent.skillId } : {}),
            prompt: mostRecent.inputPreview || 'Retry the failed routine.',
          },
        });
      }
      return items;
    },
  };
}
