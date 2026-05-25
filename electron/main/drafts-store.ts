import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';

import type { Draft, DraftStatus, NewDraft, SendAction } from '@shared/types';

import { getDb } from './db.js';

interface DraftRow {
  id: string;
  source: string;
  channel: string;
  source_item_id: string | null;
  status: string;
  title: string;
  context_summary: string | null;
  context_full: string | null;
  current_body: string;
  original_body: string;
  why: string | null;
  send_action: string;
  workflow_id: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  sent_result: string | null;
}

function rowToDraft(row: DraftRow): Draft {
  let sendAction: SendAction;
  try {
    sendAction = JSON.parse(row.send_action) as SendAction;
  } catch {
    sendAction = { mcp: '', tool: '', args: {}, bodyKey: 'body' };
  }
  let sentResult: unknown = null;
  if (row.sent_result) {
    try {
      sentResult = JSON.parse(row.sent_result);
    } catch {
      sentResult = row.sent_result;
    }
  }
  return {
    id: row.id,
    source: row.source,
    channel: row.channel,
    sourceItemId: row.source_item_id,
    status: row.status as DraftStatus,
    title: row.title,
    contextSummary: row.context_summary,
    contextFull: row.context_full,
    currentBody: row.current_body,
    originalBody: row.original_body,
    why: row.why,
    sendAction,
    workflowId: row.workflow_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    sentResult,
  };
}

export interface ListOptions {
  status?: DraftStatus | DraftStatus[];
  source?: string;
  channel?: string;
  limit?: number;
}

/**
 * Generic store for AI-generated drafts awaiting human review. Any
 * module/workflow that produces text for the user to send (email
 * replies, slack DMs, PR comments, social posts, …) writes here via
 * the `draft-store-write` node; the Drafts view reads from here.
 *
 * Per-channel dispatch lives in `Draft.sendAction` (a JSON template
 * carrying mcp+tool+args+bodyKey). At send time the store substitutes
 * the editable body into `args[bodyKey]` and calls invokeMcpTool —
 * the store itself stays channel-agnostic.
 */
export class DraftsStore extends EventEmitter {
  list(options: ListOptions = {}): Draft[] {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      if (statuses.length > 0) {
        clauses.push(
          `status IN (${statuses.map(() => '?').join(', ')})`,
        );
        params.push(...statuses);
      }
    }
    if (options.source) {
      clauses.push('source = ?');
      params.push(options.source);
    }
    if (options.channel) {
      clauses.push('channel = ?');
      params.push(options.channel);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit ?? 200;
    params.push(limit);
    const rows = db
      .prepare<unknown[], DraftRow>(
        `SELECT * FROM ai_drafts ${where} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params);
    return rows.map(rowToDraft);
  }

  get(id: string): Draft | null {
    const row = getDb()
      .prepare<[string], DraftRow>(`SELECT * FROM ai_drafts WHERE id = ?`)
      .get(id);
    return row ? rowToDraft(row) : null;
  }

  /**
   * Insert a draft. If `sourceItemId` is set and a row already exists
   * for `(source, sourceItemId)`, return the existing row instead of
   * creating a duplicate (regardless of its current status — the
   * producer can decide whether to act on a stale duplicate).
   *
   * Producers that don't have a natural id (e.g. one-shot prompts)
   * omit `sourceItemId` and get a fresh row every time.
   */
  create(input: NewDraft): Draft {
    const db = getDb();
    if (input.sourceItemId) {
      const existing = db
        .prepare<[string, string], DraftRow>(
          `SELECT * FROM ai_drafts WHERE source = ? AND source_item_id = ?`,
        )
        .get(input.source, input.sourceItemId);
      if (existing) return rowToDraft(existing);
    }
    const now = Date.now();
    const id = `dft-${nanoid(10)}`;
    db.prepare(
      `INSERT INTO ai_drafts (
        id, source, channel, source_item_id, status, title,
        context_summary, context_full, current_body, original_body,
        why, send_action, workflow_id, created_at, updated_at,
        sent_at, sent_result
      ) VALUES (
        @id, @source, @channel, @sourceItemId, 'pending', @title,
        @contextSummary, @contextFull, @body, @body,
        @why, @sendAction, @workflowId, @now, @now,
        NULL, NULL
      )`,
    ).run({
      id,
      source: input.source,
      channel: input.channel,
      sourceItemId: input.sourceItemId ?? null,
      title: input.title,
      contextSummary: input.contextSummary ?? null,
      contextFull: input.contextFull ?? null,
      body: input.body,
      why: input.why ?? null,
      sendAction: JSON.stringify(input.sendAction),
      workflowId: input.workflowId ?? null,
      now,
    });
    const draft = this.get(id);
    if (!draft) throw new Error(`drafts-store: insert ${id} did not round-trip`);
    this.emit('changed');
    return draft;
  }

  /** Replace the editable body. No-op if the draft is sent/discarded. */
  updateBody(id: string, body: string): Draft | null {
    const draft = this.get(id);
    if (!draft) return null;
    if (draft.status === 'sent' || draft.status === 'discarded') return draft;
    getDb()
      .prepare(
        `UPDATE ai_drafts SET current_body = ?, updated_at = ? WHERE id = ?`,
      )
      .run(body, Date.now(), id);
    this.emit('changed');
    return this.get(id);
  }

  /** Reset current_body to original_body (the AI's first draft). */
  revert(id: string): Draft | null {
    const draft = this.get(id);
    if (!draft) return null;
    if (draft.status === 'sent' || draft.status === 'discarded') return draft;
    getDb()
      .prepare(
        `UPDATE ai_drafts SET current_body = original_body, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    this.emit('changed');
    return this.get(id);
  }

  discard(id: string): boolean {
    const draft = this.get(id);
    if (!draft) return false;
    getDb()
      .prepare(
        `UPDATE ai_drafts SET status = 'discarded', updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    this.emit('changed');
    return true;
  }

  markSending(id: string): Draft | null {
    const draft = this.get(id);
    if (!draft) return null;
    if (draft.status !== 'pending' && draft.status !== 'failed') return draft;
    getDb()
      .prepare(
        `UPDATE ai_drafts SET status = 'sending', updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    this.emit('changed');
    return this.get(id);
  }

  markSent(id: string, result: unknown): Draft | null {
    const now = Date.now();
    getDb()
      .prepare(
        `UPDATE ai_drafts
         SET status = 'sent', sent_at = ?, updated_at = ?, sent_result = ?
         WHERE id = ?`,
      )
      .run(now, now, JSON.stringify(result ?? null), id);
    this.emit('changed');
    return this.get(id);
  }

  markFailed(id: string, errorMessage: string): Draft | null {
    const now = Date.now();
    getDb()
      .prepare(
        `UPDATE ai_drafts
         SET status = 'failed', updated_at = ?, sent_result = ?
         WHERE id = ?`,
      )
      .run(
        now,
        JSON.stringify({ error: errorMessage, at: now }),
        id,
      );
    this.emit('changed');
    return this.get(id);
  }

  /**
   * Drop sent/discarded drafts older than `olderThanMs`. Pending /
   * sending / failed rows are never pruned automatically — those need
   * the user's attention. Called periodically from index.ts.
   */
  prune(options: { olderThanMs: number }): number {
    const cutoff = Date.now() - options.olderThanMs;
    const result = getDb()
      .prepare(
        `DELETE FROM ai_drafts
         WHERE status IN ('sent', 'discarded')
           AND updated_at < ?`,
      )
      .run(cutoff);
    const deleted = Number(result.changes ?? 0);
    if (deleted > 0) this.emit('changed');
    return deleted;
  }
}
