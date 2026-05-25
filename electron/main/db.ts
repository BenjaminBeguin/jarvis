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
  // Track which launches were resumed from the skill-session pool vs.
  // launched fresh. Lets the Spend dashboard estimate savings ("of 12
  // /note turns today, 9 were pooled — skipped ~9 cold starts").
  // 0 = fresh, 1 = pooled.
  `ALTER TABLE tasks ADD COLUMN pooled INTEGER NOT NULL DEFAULT 0;`,
  // Persistent workflow run history. Previously runs lived in-memory
  // only with a 60-entry cap; restart wiped everything. `run_json`
  // holds the full WorkflowRun snapshot — runs are small (~few KB
  // even with truncated step outputs) and storing them as a blob is
  // simpler than mirroring every field as a column.
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    run_json TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, started_at DESC);`,
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
      `INSERT INTO tasks (id, skill_id, title, status, origin, started_at, ended_at, cost_usd, input_preview, sdk_session_id, routine_id, reminder_id, project_name, pooled)
       VALUES (@id, @skillId, @title, @status, @origin, @startedAt, @endedAt, @costUsd, @inputPreview, @sdkSessionId, @routineId, @reminderId, @projectName, @pooled)`,
    )
    .run({
      ...task,
      sdkSessionId: task.sdkSessionId ?? null,
      routineId: task.routineId ?? null,
      pooled: task.pooled ? 1 : 0,
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

/**
 * One-shot startup cleanup: any task row left with `status='running'`
 * from a previous process is a zombie — the runner doesn't keep state
 * across restarts, so nothing is actually driving the query loop. Mark
 * them all errored so they stop appearing as live in the AI Agent UI
 * (and stop counting toward "live" badges). Returns the row count.
 *
 * Idempotent on a clean boot (no `running` rows ⇒ zero update).
 */
export function reapZombieRunningTasks(): number {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE tasks
         SET status = 'errored',
             ended_at = COALESCE(ended_at, ?)
       WHERE status = 'running'`,
    )
    .run(now);
  return Number(result.changes ?? 0);
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
  pooled: number;
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
    pooled: row.pooled === 1,
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
/**
 * Detailed cost breakdown for the Spend dashboard. Returns:
 *   - total: sum of cost_usd for non-external tasks in [now - windowDays, now]
 *   - bySkill: per-skill totals, descending. skill_id null = palette free-text.
 *   - byOrigin: palette / routine / reminder / voice / api buckets.
 *   - byRoutine: per-routine totals (only rows with routine_id set), so the
 *     user can spot a rogue routine eating the budget.
 *   - byDay: time series, YYYY-MM-DD keyed, ascending date. Zero-spend days
 *     are filled in so the renderer can chart a continuous line.
 *
 * `windowDays` 1 = today, 7 = last week, 30 = last 30 days.
 */
export function getCostBreakdown(windowDays: number): {
  windowDays: number;
  total: number;
  bySkill: Array<{ skillId: string | null; totalUsd: number; taskCount: number }>;
  byOrigin: Array<{ origin: string; totalUsd: number; taskCount: number }>;
  byRoutine: Array<{ routineId: string; totalUsd: number; taskCount: number }>;
  byProject: Array<{ projectName: string; totalUsd: number; taskCount: number }>;
  byDay: Array<{ date: string; totalUsd: number; taskCount: number }>;
  pool: {
    /** Number of tasks in the window that resumed a pooled session (skipped cold start). */
    pooledTaskCount: number;
    /** Number of tasks that paid the cold start. */
    freshTaskCount: number;
  };
} {
  const db = getDb();
  const now = new Date();
  // Start at local midnight `windowDays - 1` ago so "last 7 days" includes
  // today + 6 prior days (7 buckets).
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (windowDays - 1));
  const since = start.getTime();

  const totalRow = db
    .prepare<[number], { total: number | null }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM tasks
       WHERE started_at >= ? AND origin != 'external'`,
    )
    .get(since);
  const total = totalRow?.total ?? 0;

  const bySkill = db
    .prepare<[number], SkillCostRow>(
      `SELECT skill_id, SUM(cost_usd) AS total, COUNT(*) AS task_count
       FROM tasks
       WHERE started_at >= ? AND origin != 'external'
       GROUP BY skill_id
       ORDER BY total DESC`,
    )
    .all(since)
    .map((r) => ({
      skillId: r.skill_id,
      totalUsd: r.total,
      taskCount: r.task_count,
    }));

  const byOrigin = db
    .prepare<[number], { origin: string; total: number; task_count: number }>(
      `SELECT origin, SUM(cost_usd) AS total, COUNT(*) AS task_count
       FROM tasks
       WHERE started_at >= ? AND origin != 'external'
       GROUP BY origin
       ORDER BY total DESC`,
    )
    .all(since)
    .map((r) => ({
      origin: r.origin,
      totalUsd: r.total,
      taskCount: r.task_count,
    }));

  const byRoutine = db
    .prepare<[number], { routine_id: string; total: number; task_count: number }>(
      `SELECT routine_id, SUM(cost_usd) AS total, COUNT(*) AS task_count
       FROM tasks
       WHERE started_at >= ? AND origin != 'external' AND routine_id IS NOT NULL
       GROUP BY routine_id
       ORDER BY total DESC`,
    )
    .all(since)
    .map((r) => ({
      routineId: r.routine_id,
      totalUsd: r.total,
      taskCount: r.task_count,
    }));

  const byProject = db
    .prepare<[number], { project_name: string; total: number; task_count: number }>(
      `SELECT project_name, SUM(cost_usd) AS total, COUNT(*) AS task_count
       FROM tasks
       WHERE started_at >= ? AND origin != 'external' AND project_name IS NOT NULL
       GROUP BY project_name
       ORDER BY total DESC`,
    )
    .all(since)
    .map((r) => ({
      projectName: r.project_name,
      totalUsd: r.total,
      taskCount: r.task_count,
    }));

  // Bucket by local day. SQLite's strftime works on epoch seconds, so we
  // pass started_at/1000 and tag with the user's local UTC offset to keep
  // the day boundary aligned with what the user sees on a clock.
  const tzOffsetMin = -now.getTimezoneOffset();
  const tzMod = `${tzOffsetMin >= 0 ? '+' : '-'}${Math.abs(tzOffsetMin)} minutes`;
  const dayRows = db
    .prepare<
      [string, number],
      { day: string; total: number; task_count: number }
    >(
      `SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', ?) AS day,
              SUM(cost_usd) AS total,
              COUNT(*) AS task_count
       FROM tasks
       WHERE started_at >= ? AND origin != 'external'
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(tzMod, since)
    .map((r) => ({
      date: r.day,
      totalUsd: r.total,
      taskCount: r.task_count,
    }));

  // Fill in zero-spend days so the renderer can render a flat line
  // instead of a gap on quiet days.
  const dayMap = new Map(dayRows.map((d) => [d.date, d]));
  const byDay: Array<{ date: string; totalUsd: number; taskCount: number }> = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    byDay.push(
      dayMap.get(key) ?? { date: key, totalUsd: 0, taskCount: 0 },
    );
  }

  const poolRow = db
    .prepare<
      [number],
      { pooled_count: number; fresh_count: number }
    >(
      `SELECT
         COALESCE(SUM(CASE WHEN pooled = 1 THEN 1 ELSE 0 END), 0) AS pooled_count,
         COALESCE(SUM(CASE WHEN pooled = 0 THEN 1 ELSE 0 END), 0) AS fresh_count
       FROM tasks
       WHERE started_at >= ? AND origin != 'external'
         AND skill_id IS NOT NULL
         AND (origin = 'palette' OR origin = 'voice')`,
    )
    .get(since);
  const pool = {
    pooledTaskCount: poolRow?.pooled_count ?? 0,
    freshTaskCount: poolRow?.fresh_count ?? 0,
  };

  return { windowDays, total, bySkill, byOrigin, byRoutine, byProject, byDay, pool };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

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

// ─── Workflow runs ──────────────────────────────────────────────────────────

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  trigger: string;
  run_json: string;
}

/**
 * Upsert a workflow run. Called on every WorkflowRunner state
 * transition so the persisted snapshot is always close to live —
 * cheap because runs are small and SQLite is fast. The full run
 * (including step outputs) is stored as JSON in `run_json`; top-
 * level columns are mirrors of common fields for indexing.
 */
export function upsertWorkflowRun(run: {
  id: string;
  workflowId: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  trigger: string;
  // Full snapshot — includes steps[], error, etc. Typed as unknown to
  // avoid a circular shared/types dependency from db.ts.
  snapshot: unknown;
}): void {
  const db = getDb();
  const runJson = JSON.stringify(run.snapshot);
  db.prepare(
    `INSERT INTO workflow_runs (
      id, workflow_id, started_at, ended_at, status, trigger, run_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = excluded.ended_at,
      status = excluded.status,
      run_json = excluded.run_json`,
  ).run(
    run.id,
    run.workflowId,
    run.startedAt,
    run.endedAt,
    run.status,
    run.trigger,
    runJson,
  );
}

/**
 * Newest-first run history, optionally filtered to one workflow id.
 * Returns parsed run JSON ready to hand back to the renderer. Caps
 * at `limit` (default 200) — past that, runs stay on disk but the
 * UI doesn't ask for them.
 */
export function listWorkflowRuns(
  workflowId: string | undefined,
  limit = 200,
): unknown[] {
  const db = getDb();
  const rows = workflowId
    ? db
        .prepare<[string, number], WorkflowRunRow>(
          `SELECT * FROM workflow_runs
           WHERE workflow_id = ?
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(workflowId, limit)
    : db
        .prepare<[number], WorkflowRunRow>(
          `SELECT * FROM workflow_runs
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(limit);
  return rows.map((r) => safeParseRun(r.run_json));
}

export function getWorkflowRun(id: string): unknown | null {
  const db = getDb();
  const row = db
    .prepare<[string], WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE id = ?`,
    )
    .get(id);
  return row ? safeParseRun(row.run_json) : null;
}

function safeParseRun(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Cap the persisted run history. Each workflow keeps at most
 * `perWorkflowCap` rows; anything older than `maxAgeMs` is dropped
 * regardless of cap (so a workflow that fires once a week doesn't
 * keep a decade of history). Returns the row count deleted.
 *
 * Called periodically from index.ts. Fast: two indexed deletes.
 */
export function pruneWorkflowRuns(opts: {
  perWorkflowCap: number;
  maxAgeMs: number;
}): number {
  const { perWorkflowCap, maxAgeMs } = opts;
  const db = getDb();
  const ageCutoff = Date.now() - maxAgeMs;
  let deleted = 0;
  // Age-based prune first — strictly oldest, no per-workflow logic.
  const ageResult = db
    .prepare(`DELETE FROM workflow_runs WHERE started_at < ?`)
    .run(ageCutoff);
  deleted += Number(ageResult.changes ?? 0);
  // Per-workflow cap. For each workflow_id, keep the N most recent
  // rows; delete the rest. Done in a single CTE so we don't iterate
  // workflows in JS.
  const capResult = db
    .prepare(
      `DELETE FROM workflow_runs
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY workflow_id
               ORDER BY started_at DESC
             ) AS rn
           FROM workflow_runs
         )
         WHERE rn > ?
       )`,
    )
    .run(perWorkflowCap);
  deleted += Number(capResult.changes ?? 0);
  return deleted;
}
