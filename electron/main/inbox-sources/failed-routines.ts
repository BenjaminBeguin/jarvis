import type { InboxItem, TaskSummary } from '@shared/types';

import { listRecentTasks } from '../db.js';
import type { InboxSource } from '../inbox.js';

/**
 * Recently-errored Jarvis tasks worth a second look. Focus on routines
 * specifically (rather than every errored task) because palette tasks
 * the user already saw error live. A routine that fired overnight +
 * errored is what actually slips through the cracks.
 *
 * Scope: errored routine tasks from the last 24h, **deduplicated by
 * routineId** (falling back to skillId for legacy rows that pre-date
 * the entity-link migration). A routine that fires every 10 min and
 * breaks would otherwise produce dozens of inbox rows for the same
 * problem — instead we show one row per routine with the
 * consecutive-failure streak as subtitle context, so 3 failures in a
 * row reads as one urgent item, not 3.
 *
 * Grouping by routineId rather than skillId is exact (two routines
 * that share a skill, e.g. daily-recap and a one-off recap retry,
 * don't merge into one streak anymore).
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

      // Group by routineId where available; fall back to skillId for
      // tasks that pre-date the routine_id column (their value is
      // null). Unkeyed tasks (no routineId AND no skillId) get a
      // singleton bucket — they don't streak with anything.
      const byKey = new Map<string, TaskSummary[]>();
      for (const t of routineTasks) {
        const key = t.routineId ?? t.skillId ?? `__unkeyed-${t.id}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(t);
      }

      const items: InboxItem[] = [];
      for (const [key, tasks] of byKey) {
        // Tasks are already sorted DESC by startedAt from the query.
        // Skip groups where the most recent run succeeded — not
        // currently broken.
        const mostRecent = tasks[0];
        if (!mostRecent || mostRecent.status !== 'errored') continue;
        // Only surface if the most recent error is within the 24h
        // window — otherwise we'd nag about a routine the user already
        // triaged days ago.
        if (mostRecent.startedAt < horizon) continue;

        // Count consecutive failures from the head — stop at the first
        // non-errored run.
        let streak = 0;
        for (const t of tasks) {
          if (t.status === 'errored') streak += 1;
          else break;
        }

        // Prefer routineId in the label since that's the exact entity
        // the user can find in the Routines tab. Fall back to skillId
        // for legacy rows.
        const label = key.startsWith('__unkeyed-')
          ? ''
          : mostRecent.routineId
          ? ` · routine:${mostRecent.routineId}`
          : mostRecent.skillId
          ? ` · ${mostRecent.skillId}`
          : '';
        const streakLabel = streak >= 2 ? ` · ${streak} in a row` : '';
        items.push({
          id: `failed-${mostRecent.id}`,
          source: 'failed-routines',
          title: mostRecent.title,
          subtitle: `Routine failed${label}${streakLabel}`,
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
