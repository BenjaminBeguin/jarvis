import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import type { TaskSummary } from '@shared/types';

import type { Module, ModuleContext } from './types.js';

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/** Sessions touched within this window are surfaced on startup. */
const STARTUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A session is "running" if its file was modified more recently than this. */
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;
/** How often we sweep to flip stale sessions to "completed". */
const SWEEP_INTERVAL_MS = 30 * 1000;
/** Trim title to a sensible width for the sidebar. */
const TITLE_MAX_CHARS = 72;

interface SessionState {
  taskId: string;
  filePath: string;
  projectSlug: string;
  position: number;
  lastEventAt: number;
  startedAt: number;
}

function deriveTaskId(filePath: string): string {
  return `cc-${basename(filePath, '.jsonl')}`;
}

function prettyProject(slug: string): string {
  // "-Users-benjaminbeguin-Documents-Perso-code-perso-jarvis" → "jarvis"
  const trimmed = slug.replace(/^-+/, '');
  const segments = trimmed.split('-').filter(Boolean);
  return segments[segments.length - 1] ?? trimmed;
}

function truncate(s: string, max = TITLE_MAX_CHARS): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length > max ? `${oneline.slice(0, max - 1)}…` : oneline;
}

/**
 * Map a Claude Code JSONL event onto something the existing TaskDetail
 * renderer already understands (SDKMessage-shaped). Returns null if the line
 * isn't interesting enough to render.
 */
function transformEvent(line: unknown): unknown | null {
  if (!line || typeof line !== 'object') return null;
  const event = line as Record<string, unknown>;

  if (event['type'] === 'queue-operation' && event['operation'] === 'enqueue') {
    const content = event['content'];
    if (typeof content !== 'string' || !content.trim()) return null;
    return {
      type: 'user',
      message: { content: [{ type: 'text', text: content }] },
    };
  }

  if (event['type'] === 'assistant' && event['message']) {
    return event;
  }

  if (event['type'] === 'system') {
    return event;
  }

  return null;
}

function extractTitle(filePath: string): string {
  try {
    const buf = readFileSync(filePath, 'utf8');
    for (const line of buf.split('\n').slice(0, 40)) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const e = parsed as Record<string, unknown>;
      if (
        e['type'] === 'queue-operation' &&
        e['operation'] === 'enqueue' &&
        typeof e['content'] === 'string' &&
        e['content']
      ) {
        return truncate(e['content']);
      }
    }
  } catch {
    // unreadable; fall through
  }
  return 'Claude Code session';
}

export class ClaudeCodeWatchModule implements Module {
  readonly id = 'claude-code-watch';
  readonly name = 'Claude Code observer';
  readonly description =
    'Surface live Claude Code sessions from ~/.claude/projects/ in the observatory';
  readonly version = '1.0.0';

  private ctx: ModuleContext | null = null;
  private watcher: FSWatcher | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, SessionState>();

  async onLoad(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    if (!existsSync(PROJECTS_ROOT)) {
      // No Claude Code on this machine; nothing to do.
      return;
    }

    // Initial scan: synchronous and fast — we just stat + register, no event replay.
    this.scanExisting();

    // chokidar with ignoreInitial so we don't re-fire 'add' for everything we
    // just scanned. New files appearing later still come through.
    this.watcher = chokidar.watch(`${PROJECTS_ROOT}/**/*.jsonl`, {
      ignoreInitial: true,
      awaitWriteFinish: false,
      depth: 3,
    });
    this.watcher.on('add', (p: string) => this.onAdd(p));
    this.watcher.on('change', (p: string) => this.onChange(p));

    this.sweep = setInterval(() => this.sweepStatus(), SWEEP_INTERVAL_MS);
  }

  async onUnload(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    await this.watcher?.close();
    this.watcher = null;
  }

  private scanExisting(): void {
    let projects: string[] = [];
    try {
      projects = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return;
    }
    for (const slug of projects) {
      const projDir = join(PROJECTS_ROOT, slug);
      let files: string[] = [];
      try {
        files = readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const filePath = join(projDir, f);
        try {
          const stat = statSync(filePath);
          if (Date.now() - stat.mtimeMs > STARTUP_WINDOW_MS) continue;
          this.ingest(filePath, slug, stat.size, stat.mtimeMs, stat.birthtimeMs);
        } catch {
          // skip
        }
      }
    }
  }

  private ingest(
    filePath: string,
    projectSlug: string,
    fileSize: number,
    mtimeMs: number,
    birthtimeMs: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const taskId = deriveTaskId(filePath);
    if (ctx.hasExternalTask(taskId)) return;

    const title = `${prettyProject(projectSlug)} · ${extractTitle(filePath)}`;
    const isActive = Date.now() - mtimeMs < ACTIVE_THRESHOLD_MS;
    const summary: TaskSummary = {
      id: taskId,
      skillId: null,
      title,
      status: isActive ? 'running' : 'completed',
      origin: 'external',
      startedAt: birthtimeMs || mtimeMs,
      endedAt: isActive ? null : mtimeMs,
      costUsd: 0,
      inputPreview: title,
      groupKey: `claude-code:${projectSlug}`,
    };
    ctx.registerExternalTask(summary);

    this.sessions.set(filePath, {
      taskId,
      filePath,
      projectSlug,
      // Start tailing from the end — we don't want to flood with history on
      // launch. Live events from now on appear in real time.
      position: fileSize,
      lastEventAt: mtimeMs,
      startedAt: summary.startedAt,
    });
  }

  private onAdd(filePath: string): void {
    if (this.sessions.has(filePath)) return;
    try {
      const stat = statSync(filePath);
      const slug = basename(join(filePath, '..'));
      this.ingest(filePath, slug, stat.size, stat.mtimeMs, stat.birthtimeMs);
    } catch {
      /* skip */
    }
  }

  private onChange(filePath: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let state = this.sessions.get(filePath);
    if (!state) {
      this.onAdd(filePath);
      state = this.sessions.get(filePath);
      if (!state) return;
    }
    this.tail(state);
    ctx.updateExternalTaskStatus(state.taskId, 'running', null);
    state.lastEventAt = Date.now();
  }

  private tail(state: SessionState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let fileSize: number;
    try {
      fileSize = statSync(state.filePath).size;
    } catch {
      return;
    }
    if (fileSize <= state.position) return;

    const stream = createReadStream(state.filePath, {
      start: state.position,
      encoding: 'utf8',
    });
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    stream.on('end', () => {
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) return;
      const complete = buffer.slice(0, lastNewline);
      state.position += Buffer.byteLength(complete, 'utf8') + 1;
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const event = transformEvent(parsed);
        if (event) ctx.recordExternalEvent(state.taskId, event);
      }
    });
    stream.on('error', () => {
      /* ignore — next change will retry */
    });
  }

  private sweepStatus(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = Date.now();
    for (const state of this.sessions.values()) {
      let mtime: number;
      try {
        mtime = statSync(state.filePath).mtimeMs;
      } catch {
        continue;
      }
      const isActive = now - mtime < ACTIVE_THRESHOLD_MS;
      ctx.updateExternalTaskStatus(
        state.taskId,
        isActive ? 'running' : 'completed',
        isActive ? null : mtime,
      );
    }
  }
}

export const claudeCodeWatchModule = new ClaudeCodeWatchModule();
