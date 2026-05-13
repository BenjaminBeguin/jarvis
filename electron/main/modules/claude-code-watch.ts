import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { TaskSummary } from '@shared/types';

import type { Module, ModuleContext } from './types.js';

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/** Sessions touched within this window are surfaced on startup. */
const STARTUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A session is "running" if its file was modified more recently than this. */
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
/** How often we re-scan for new content, new sessions, and status changes. */
const POLL_INTERVAL_MS = 1500;
/** Trim title to a sensible width for the sidebar. */
const TITLE_MAX_CHARS = 72;
/** How many recent events we backfill so a clicked node has context. */
const BACKFILL_EVENT_COUNT = 10;

type LastEventKind = 'user' | 'assistant' | 'system' | null;

interface SessionState {
  taskId: string;
  filePath: string;
  projectSlug: string;
  position: number;
  lastEventAt: number;
  startedAt: number;
  lastEventKind: LastEventKind;
}

function eventKind(transformed: unknown): LastEventKind {
  if (!transformed || typeof transformed !== 'object') return null;
  const t = (transformed as { type?: unknown }).type;
  if (t === 'user' || t === 'assistant' || t === 'system') return t;
  return null;
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

interface SessionContext {
  title: string;
  backfill: unknown[];
  lastKind: LastEventKind;
}

function extractSessionContext(filePath: string): SessionContext {
  const ctx: SessionContext = {
    title: 'Claude Code session',
    backfill: [],
    lastKind: null,
  };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return ctx;
  }
  const lines = raw.split('\n');

  // Title: first user prompt anywhere in the head of the file.
  for (const line of lines.slice(0, 60)) {
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
      ctx.title = truncate(e['content']);
      break;
    }
  }

  // Backfill: walk from the END, collect last N renderable events. Reverse at
  // the end so the renderer sees them in chronological order. The FIRST event
  // we hit (last in file order) tells us if the agent is awaiting input.
  const collected: unknown[] = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < BACKFILL_EVENT_COUNT; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = transformEvent(parsed);
    if (!event) continue;
    if (ctx.lastKind === null) ctx.lastKind = eventKind(event);
    collected.push(event);
  }
  ctx.backfill = collected.reverse();
  return ctx;
}

export class ClaudeCodeWatchModule implements Module {
  readonly id = 'claude-code-watch';
  readonly name = 'Claude Code observer';
  readonly description =
    'Surface live Claude Code sessions from ~/.claude/projects/ in the observatory';
  readonly version = '1.0.0';

  private ctx: ModuleContext | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, SessionState>();

  async onLoad(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    if (!existsSync(PROJECTS_ROOT)) {
      // No Claude Code on this machine; nothing to do.
      return;
    }

    // Initial pass: discover sessions modified within the window, set them up
    // with position = EOF so we don't replay history into the registry.
    this.scanExisting();

    // Pure interval polling. We previously tried chokidar (both native and
    // usePolling) but it blew through macOS's file-descriptor limit on
    // machines with many Claude Code projects — chokidar still holds dir
    // watch handles even in polling mode. A 1.5s readdir+stat sweep over
    // ~500 files is cheap and bounded.
    this.poll = setInterval(() => this.scanAll(), POLL_INTERVAL_MS);
  }

  async onUnload(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
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

    const { title: rawTitle, backfill, lastKind } = extractSessionContext(filePath);
    const title = `${prettyProject(projectSlug)} · ${rawTitle}`;
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
      awaitingInput: lastKind === 'assistant',
    };
    ctx.registerExternalTask(summary);

    // Backfill recent events so clicking the node immediately shows context.
    for (const event of backfill) {
      ctx.recordExternalEvent(taskId, event);
    }

    this.sessions.set(filePath, {
      taskId,
      filePath,
      projectSlug,
      // Start tailing from the end — we don't want to flood with history on
      // launch. Live events from now on appear in real time.
      position: fileSize,
      lastEventAt: mtimeMs,
      startedAt: summary.startedAt,
      lastEventKind: lastKind,
    });
  }

  /**
   * One pass over PROJECTS_ROOT: ingest any new session, tail bytes for any
   * session whose file grew since we last looked, and reconcile running/idle
   * status for everything we know about.
   */
  private scanAll(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let projects: string[];
    try {
      projects = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return;
    }
    const seen = new Set<string>();
    const now = Date.now();

    for (const slug of projects) {
      const projDir = join(PROJECTS_ROOT, slug);
      let files: string[];
      try {
        files = readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const filePath = join(projDir, f);
        seen.add(filePath);
        let stat;
        try {
          stat = statSync(filePath);
        } catch {
          continue;
        }
        const existing = this.sessions.get(filePath);
        if (!existing) {
          if (now - stat.mtimeMs > STARTUP_WINDOW_MS) continue;
          this.ingest(filePath, slug, stat.size, stat.mtimeMs, stat.birthtimeMs);
          continue;
        }
        // Existing session — drain any new content.
        if (stat.size > existing.position) {
          this.tail(existing);
          existing.lastEventAt = now;
        }
        const isActive = now - stat.mtimeMs < ACTIVE_THRESHOLD_MS;
        ctx.updateExternalTaskStatus(
          existing.taskId,
          isActive ? 'running' : 'completed',
          isActive ? null : stat.mtimeMs,
        );
      }
    }

    // Sessions whose file disappeared (rare — Claude Code doesn't usually
    // delete its own logs): drop them from tracking. The TaskSummary stays
    // in the registry until app restart, which is fine.
    for (const [path] of this.sessions) {
      if (!seen.has(path)) this.sessions.delete(path);
    }
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
      let latestKind: LastEventKind = null;
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const event = transformEvent(parsed);
        if (!event) continue;
        ctx.recordExternalEvent(state.taskId, event);
        const k = eventKind(event);
        if (k) latestKind = k;
      }
      if (latestKind) {
        state.lastEventKind = latestKind;
        ctx.updateExternalTaskMeta(state.taskId, {
          awaitingInput: latestKind === 'assistant',
        });
      }
    });
    stream.on('error', () => {
      /* ignore — next change will retry */
    });
  }

}

export const claudeCodeWatchModule = new ClaudeCodeWatchModule();
