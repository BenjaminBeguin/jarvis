import type { InboxItem } from '@shared/types';

import { listRecentTasks } from '../db.js';
import type { InboxSource } from '../inbox.js';

/**
 * Recently-errored Jarvis tasks worth a second look. We focus on routines
 * specifically (rather than every errored task) because palette tasks the
 * user already saw error live — they don't need a second surface for
 * them. A routine that fired overnight + errored is what actually slips
 * through the cracks.
 *
 * Scope: errored tasks from the last 24h.
 */
export function failedRoutinesInboxSource(): InboxSource {
  return {
    name: 'failed-routines',
    label: 'Needs attention',
    async fetch(): Promise<InboxItem[]> {
      const horizon = Date.now() - 24 * 60 * 60 * 1000;
      const recent = listRecentTasks(100);
      return recent
        .filter(
          (t) =>
            t.origin === 'routine' &&
            t.status === 'errored' &&
            t.startedAt >= horizon,
        )
        .map((t) => ({
          id: `failed-${t.id}`,
          source: 'failed-routines',
          title: t.title,
          subtitle: `Routine failed${t.skillId ? ` · ${t.skillId}` : ''}`,
          createdAt: t.endedAt ?? t.startedAt,
          action: {
            label: 'Retry',
            ...(t.skillId ? { skillId: t.skillId } : {}),
            prompt: t.inputPreview || 'Retry the failed routine.',
          },
        }));
    },
  };
}
