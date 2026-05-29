import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative } from 'node:path';

import type { ArtifactInput } from '@shared/types';

import { getDb } from '../db.js';
import { deleteArtifact, upsertArtifact } from './registry.js';

/**
 * One-time backfill pass: scan every Jarvis-owned artifact directory
 * + SQLite-backed stores, register everything into the artifacts
 * table. Idempotent — re-runs find existing rows and upsert in place.
 *
 * Runs in the background after app boot so it doesn't block UI.
 * Emits 'progress' events the tray subscribes to for a status badge:
 *
 *   backfillEvents.on('progress', ({ done, total }) => { … });
 *   backfillEvents.on('done', () => { … });
 *
 * Sources covered in v1:
 *   - ~/.jarvis/meetings/**\/*.md (and per-project subdirs)
 *   - ~/.jarvis/notes/**\/*.md
 *   - ~/.jarvis/briefings/**\/*.md
 *   - ~/.jarvis/projects/<slug>/memory/*.md
 *   - SQLite: tasks, goals (~/.jarvis/goals.json), reminders
 *     (~/.jarvis/reminders.json), ai_drafts
 *
 * NOT covered (intentional v1 scope):
 *   - Workflow run history (too verbose; backfill from live runs)
 *   - Inbox JSON items (those refresh every 5 min; let the live
 *     watcher pick up changes)
 *   - Activity log events (single-line side effects; not useful as
 *     search targets)
 */

export const backfillEvents = new EventEmitter();

interface PendingArtifact extends ArtifactInput {
  /** Used by the throttler to spread upsert calls across time. */
  _src: string;
}

let running = false;

export async function backfillArtifacts(): Promise<void> {
  if (running) return;
  running = true;
  // One-time prune: drop low-value artifacts already in the catalog
  // from earlier (pre-quality-gate) backfill runs. Idempotent — re-
  // runs just re-check + delete the same rows.
  try {
    pruneLowValueArtifacts();
  } catch (err) {
    console.warn('[backfill:prune]', err);
  }
  const jarvisRoot = join(homedir(), '.jarvis');
  const pending: PendingArtifact[] = [];

  // Collect from all sources without writing yet so we know the total
  // for progress reporting.
  try {
    pending.push(...scanMeetings(jarvisRoot));
  } catch (err) {
    console.warn('[backfill:meetings]', err);
  }
  try {
    pending.push(...scanNotes(jarvisRoot));
  } catch (err) {
    console.warn('[backfill:notes]', err);
  }
  try {
    pending.push(...scanBriefings(jarvisRoot));
  } catch (err) {
    console.warn('[backfill:briefings]', err);
  }
  try {
    pending.push(...scanProjectMemory(jarvisRoot));
  } catch (err) {
    console.warn('[backfill:project-memory]', err);
  }
  try {
    pending.push(...scanSqliteStores());
  } catch (err) {
    console.warn('[backfill:sqlite]', err);
  }

  const total = pending.length;
  console.log(`[backfill] ${total} artifacts queued`);
  backfillEvents.emit('progress', { done: 0, total });

  // Throttle to ~10 upserts/sec so embedding worker isn't slammed and
  // the UI thread stays responsive. The upsert itself is fast (SQLite
  // write); the embedding fire-and-forget is what we're pacing for.
  const BATCH_SIZE = 5;
  const PAUSE_MS = 250;
  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    for (const a of batch) {
      try {
        await upsertArtifact(a);
      } catch (err) {
        console.warn(`[backfill] upsert failed for ${a.id}:`, err);
      }
      done++;
    }
    backfillEvents.emit('progress', { done, total });
    if (i + BATCH_SIZE < pending.length) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }
  backfillEvents.emit('done', { total });
  console.log(`[backfill] completed ${done}/${total}`);
  running = false;
}

/**
 * Drop rows that fail the current quality bar — kind='task' (always),
 * placeholder content, and bodies too short to produce useful hits.
 * Idempotent. Used as a one-time prune on each backfill so the
 * catalog converges to the current isMeaningful definition without
 * the user having to nuke jarvis.sqlite.
 */
function pruneLowValueArtifacts(): void {
  const db = getDb();
  // Tasks — we no longer index these at all.
  const taskIds = db
    .prepare(`SELECT id FROM artifacts WHERE kind = 'task'`)
    .all() as Array<{ id: string }>;
  // Joined content per artifact, then per-row filter.
  const others = db
    .prepare(
      `SELECT a.id AS id, a.kind AS kind, a.title AS title,
              COALESCE((
                SELECT GROUP_CONCAT(content, ' ')
                FROM artifact_chunks WHERE artifact_id = a.id
              ), '') AS content
       FROM artifacts a WHERE a.kind != 'task'`,
    )
    .all() as Array<{
    id: string;
    kind: string;
    title: string;
    content: string;
  }>;
  const droppable: string[] = taskIds.map((r) => r.id);
  for (const r of others) {
    const content = r.content.trim();
    if (
      /^_?no speech detected_?$/i.test(content) ||
      /^_?nothing to report_?$/i.test(content)
    ) {
      droppable.push(r.id);
      continue;
    }
    if (r.kind === 'reminder' || r.kind === 'goal') continue; // anchors
    const tokens = content
      .replace(/[`*_>#~|\\(){}[\]]/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    if (tokens.length < 8) droppable.push(r.id);
  }
  if (droppable.length === 0) return;
  for (const id of droppable) deleteArtifact(id);
  console.log(`[backfill] pruned ${droppable.length} low-value artifacts`);
}

// ─── File scanners ──────────────────────────────────────────────────────

function scanMeetings(root: string): PendingArtifact[] {
  const dir = join(root, 'meetings');
  return scanMarkdownDir(dir, dir, 'meeting').map((a) => ({
    ...a,
    url: `vscode://file${a.path}`,
  }));
}

function scanNotes(root: string): PendingArtifact[] {
  const dir = join(root, 'notes');
  // Notes are one file per day with multiple ## HH:MM entries — we
  // index each day as a single artifact. Per-entry indexing would
  // create too many tiny artifacts with little context.
  return scanMarkdownDir(dir, dir, 'note').map((a) => ({
    ...a,
    url: `vscode://file${a.path}`,
  }));
}

function scanBriefings(root: string): PendingArtifact[] {
  const dir = join(root, 'briefings');
  return scanMarkdownDir(dir, dir, 'briefing').map((a) => ({
    ...a,
    url: `vscode://file${a.path}`,
  }));
}

function scanProjectMemory(root: string): PendingArtifact[] {
  const projectsRoot = join(root, 'projects');
  if (!existsSync(projectsRoot)) return [];
  const out: PendingArtifact[] = [];
  for (const entry of readdirSync(projectsRoot)) {
    const memoryDir = join(projectsRoot, entry, 'memory');
    if (!existsSync(memoryDir)) continue;
    const slug = entry;
    const items = scanMarkdownDir(memoryDir, memoryDir, 'project-memory', {
      project: slug,
    });
    for (const item of items) {
      out.push({ ...item, url: `vscode://file${item.path}` });
    }
  }
  return out;
}

interface ScanOpts {
  project?: string;
}

function scanMarkdownDir(
  rootDir: string,
  walkDir: string,
  kind: string,
  opts: ScanOpts = {},
): PendingArtifact[] {
  if (!existsSync(walkDir)) return [];
  const out: PendingArtifact[] = [];
  for (const entry of readdirSync(walkDir)) {
    if (entry.startsWith('.')) continue;
    const full = join(walkDir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // For meetings + notes, subdirs are per-project. Recurse.
      const subProject = opts.project ?? entry;
      out.push(
        ...scanMarkdownDir(rootDir, full, kind, { project: subProject }),
      );
      continue;
    }
    if (extname(entry).toLowerCase() !== '.md') continue;
    try {
      const raw = readFileSync(full, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const relPath = relative(rootDir, full);
      const slug = relPath.replace(/[\\/]/g, '__').replace(/\.md$/i, '');
      const title = (meta['title'] || entry.replace(/\.md$/i, '')) as string;
      const project =
        (typeof meta['project'] === 'string' ? meta['project'] : null) ??
        opts.project ??
        null;
      out.push({
        _src: full,
        id: `${kind}:${slug}`,
        kind,
        title,
        project,
        path: full,
        url: null,
        frontmatter: meta as Record<string, unknown>,
        content: body,
        createdAt: stat.birthtimeMs || stat.mtimeMs,
      });
    } catch (err) {
      console.warn(`[backfill] failed to read ${full}:`, err);
    }
  }
  return out;
}

function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) meta[k] = v;
  }
  return { meta, body: match[2] ?? '' };
}

// ─── SQLite scanners ────────────────────────────────────────────────────

interface DraftRow {
  id: string;
  source: string;
  title: string;
  current_body: string;
  why: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

function scanSqliteStores(): PendingArtifact[] {
  const out: PendingArtifact[] = [];
  const db = getDb();

  // Tasks intentionally NOT backfilled. The launch prompt
  // (input_preview) on its own is just "what someone asked Jarvis
  // to do" — the actual produced work lives in meetings, notes,
  // briefings, drafts. Indexing tasks dilutes the catalog with rows
  // that have no useful body. (Quality gate in
  // isMeaningfulArtifact also drops them defensively.)

  // Drafts — current_body + why is the searchable content.
  try {
    const drafts = db
      .prepare(
        `SELECT id, source, title, current_body, why, status, created_at, updated_at
         FROM ai_drafts WHERE status != 'discarded'`,
      )
      .all() as DraftRow[];
    for (const d of drafts) {
      const body = d.why ? `${d.why}\n\n${d.current_body}` : d.current_body;
      out.push({
        _src: `sqlite:drafts:${d.id}`,
        id: `draft:${d.id}`,
        kind: 'draft',
        title: d.title,
        project: null,
        path: null,
        url: null,
        frontmatter: { source: d.source, status: d.status },
        content: body,
        createdAt: d.created_at,
      });
    }
  } catch (err) {
    console.warn('[backfill:drafts]', err);
  }

  // Goals + Reminders are JSON-file stores; their respective Store
  // classes are the source of truth. The store-emit hooks (Layer 1
  // wire sites) will register them on the next mutation. We don't
  // backfill those here to avoid pulling in those store deps from a
  // pure-utility file; instead, schedule a one-shot "register all"
  // call in the boot path that runs after the stores init.

  return out;
}
