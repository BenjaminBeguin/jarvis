import { EventEmitter } from 'node:events';

import type { ActivityEvent, ActivityEventInput } from '@shared/types';

import { getDb } from './db.js';

/**
 * Append-only log of non-agent side-effects: meeting started, note
 * archived, MCP disabled, etc. Persisted in SQLite so the Activity
 * tab can show "things you did" across restarts.
 *
 * Agent-run history lives in the existing `tasks` + `task_events`
 * tables; the renderer merges both streams. We intentionally don't
 * write task events here — that'd just duplicate data.
 *
 * Keep `kind` short and dotted ('meeting.started', 'note.created').
 * `label` is the human one-line; `detail` is anything kind-specific
 * the renderer wants to format (skillId for a link, file path for a
 * reveal button, etc.).
 */

const RETENTION_LIMIT = 5000;

export class ActivityStore extends EventEmitter {
  /** Append a row + broadcast. Cheap; fire-and-forget from callers. */
  record(input: ActivityEventInput): void {
    const ts = input.ts ?? Date.now();
    let id: number;
    try {
      const r = getDb()
        .prepare(
          'INSERT INTO activity_events (ts, kind, label, detail_json) VALUES (?, ?, ?, ?)',
        )
        .run(
          ts,
          input.kind,
          input.label,
          input.detail ? JSON.stringify(input.detail) : null,
        );
      id = Number(r.lastInsertRowid);
    } catch (err) {
      console.warn('ActivityStore: insert failed', err);
      return;
    }
    const event: ActivityEvent = {
      id,
      ts,
      kind: input.kind,
      label: input.label,
      detail: input.detail,
    };
    this.emit('changed', event);
    // Cheap retention pass — runs only when we cross the limit so most
    // writes stay single-statement.
    if (id % 100 === 0) this.prune();
  }

  /** Newest first; default 100 rows. */
  list(limit = 100): ActivityEvent[] {
    type Row = {
      id: number;
      ts: number;
      kind: string;
      label: string;
      detail_json: string | null;
    };
    let rows: Row[];
    try {
      rows = getDb()
        .prepare(
          'SELECT id, ts, kind, label, detail_json FROM activity_events ORDER BY ts DESC, id DESC LIMIT ?',
        )
        .all(limit) as Row[];
    } catch {
      return [];
    }
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      label: r.label,
      detail: r.detail_json ? safeParse(r.detail_json) : undefined,
    }));
  }

  private prune(): void {
    try {
      getDb()
        .prepare(
          `DELETE FROM activity_events WHERE id NOT IN (
             SELECT id FROM activity_events ORDER BY ts DESC, id DESC LIMIT ?
           )`,
        )
        .run(RETENTION_LIMIT);
    } catch {
      // Best-effort — pruning failure isn't fatal.
    }
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
