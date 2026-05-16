import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

import type { TaskEvent, TaskOrigin, TaskStatus, TaskSummary } from '@shared/types';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    skill_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    origin TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_preview TEXT NOT NULL DEFAULT ''
  );`,
  `CREATE TABLE IF NOT EXISTS task_events (
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, seq),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_started_at ON tasks(started_at DESC);`,
  // P12: store the Claude Code session id so a TaskDetail loaded from
  // history can still offer the "Open in Claude Code Desktop" / "Copy
  // resume command" buttons after a restart.
  `ALTER TABLE tasks ADD COLUMN sdk_session_id TEXT;`,
  // Activity log — Phase 2. Non-agent side-effects (meeting started,
  // note created, MCP disabled, …) so the Activity tab can show
  // "everything that happened" alongside the task-derived /send rows.
  // `kind` is a dotted name ('meeting.started'); `detail_json` carries
  // arbitrary structured data the renderer can format per kind.
  `CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    detail_json TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_events(ts DESC);`,
  // Entity linking — without these, origin='routine' tells you *that*
  // a routine fired the task but not *which* routine. Same for reminders
  // and projects. Nullable columns + no backfill of historical rows
  // (they stay null; new rows get the link). Three separate ALTER
  // statements because SQLite doesn't support multi-column adds.
  `ALTER TABLE tasks ADD COLUMN routine_id TEXT;`,
  `ALTER TABLE tasks ADD COLUMN reminder_id TEXT;`,
  `ALTER TABLE tasks ADD COLUMN project_name TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_routine_id ON tasks(routine_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_project_name ON tasks(project_name);`,
];

let db: DatabaseType | null = null;

export function initDatabase(): DatabaseType {
  if (db) return db;
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'jarvis.sqlite');
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      // SQLite has no `ADD COLUMN IF NOT EXISTS` — re-runs of an additive
      // migration legitimately throw "duplicate column" once the column
      // is in place. CREATE / INDEX statements use IF NOT EXISTS so they
      // don't reach here. Anything else, rethrow loudly.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }
  return db;
}

export function getDb(): DatabaseType {
  if (!db) throw new Error('database not initialized');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function insertTask(task: TaskSummary): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, skill_id, title, status, origin, started_at, ended_at, cost_usd, input_preview, sdk_session_id, routine_id, reminder_id, project_name)
       VALUES (@id, @skillId, @title, @status, @origin, @startedAt, @endedAt, @costUsd, @inputPreview, @sdkSessionId, @routineId, @reminderId, @projectName)`,
    )
    .run({
      ...task,
      sdkSessionId: task.sdkSessionId ?? null,
      routineId: task.routineId ?? null,
      reminderId: task.reminderId ?? null,
      projectName: task.projectName ?? null,
    });
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  endedAt: number | null,
  costUsd: number,
  sdkSessionId?: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, ended_at = ?, cost_usd = ?, sdk_session_id = COALESCE(?, sdk_session_id) WHERE id = ?`,
    )
    .run(status, endedAt, costUsd, sdkSessionId ?? null, id);
}

export function appendTaskEvent(taskId: string, event: TaskEvent): void {
  getDb()
    .prepare(
      `INSERT INTO task_events (task_id, seq, ts, payload) VALUES (?, ?, ?, ?)`,
    )
    .run(taskId, event.seq, event.ts, JSON.stringify(event.msg));
}

interface TaskRow {
  id: string;
  skill_id: string | null;
  title: string;
  status: string;
  origin: string;
  started_at: number;
  ended_at: number | null;
  cost_usd: number;
  input_preview: string;
  sdk_session_id: string | null;
  routine_id: string | null;
  reminder_id: string | null;
  project_name: string | null;
}

function rowToTask(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    skillId: row.skill_id,
    title: row.title,
    status: row.status as TaskStatus,
    origin: row.origin as TaskOrigin,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    costUsd: row.cost_usd,
    inputPreview: row.input_preview,
    sdkSessionId: row.sdk_session_id,
    routineId: row.routine_id,
    reminderId: row.reminder_id,
    projectName: row.project_name,
  };
}

export function listRecentTasks(limit = 50): TaskSummary[] {
  return getDb()
    .prepare<[number], TaskRow>(
      `SELECT * FROM tasks ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit)
    .map(rowToTask);
}

export function getTaskEvents(taskId: string): TaskEvent[] {
  const rows = getDb()
    .prepare<[string], { seq: number; ts: number; payload: string }>(
      `SELECT seq, ts, payload FROM task_events WHERE task_id = ? ORDER BY seq ASC`,
    )
    .all(taskId);
  return rows.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    msg: JSON.parse(r.payload),
  }));
}

interface SkillCostRow {
  skill_id: string | null;
  total: number;
  task_count: number;
}

/**
 * Aggregate cost summary for the dashboard. Returns:
 *   - today: sum since local midnight
 *   - last7days: sum over the last 7 calendar days
 *   - thisMonth: sum since the 1st of the current month
 *   - topSkills: top 3 skills by total cost over the last 30 days
 * External-origin tasks (claude-code mirrors) are excluded — their cost
 * is unknown to Jarvis (Claude Code spends, not us).
 */
export function getCostSummary(): {
  today: number;
  last7days: number;
  thisMonth: number;
  topSkills: { skillId: string | null; totalUsd: number; taskCount: number }[];
} {
  const db = getDb();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const sum = (since: number): number => {
    const row = db
      .prepare<[number], { total: number | null }>(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM tasks
         WHERE started_at >= ? AND origin != 'external'`,
      )
      .get(since);
    return row?.total ?? 0;
  };

  const topSkills = db
    .prepare<[number], SkillCostRow>(
      `SELECT skill_id, SUM(cost_usd) AS total, COUNT(*) AS task_count
       FROM tasks
       WHERE started_at >= ? AND origin != 'external' AND cost_usd > 0
       GROUP BY skill_id
       ORDER BY total DESC
       LIMIT 3`,
    )
    .all(thirtyDaysAgo);

  return {
    today: sum(startOfToday),
    last7days: sum(sevenDaysAgo),
    thisMonth: sum(startOfMonth),
    topSkills: topSkills.map((r) => ({
      skillId: r.skill_id,
      totalUsd: r.total,
      taskCount: r.task_count,
    })),
  };
}
