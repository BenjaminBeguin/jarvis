import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import chokidar, { type FSWatcher } from 'chokidar';

/**
 * Generic document-collection primitive. The first concrete collection
 * is "Briefings" (daily-recap, weekly-retro, today-focus), but the
 * shape supports any future kind of generated markdown: status
 * reports, ADRs, cost reports, learning notes, saved drafts.
 *
 * A **kind** is a category. Each kind has an id, a label, an optional
 * skillId that produces new files, and an optional cron schedule hint.
 * Files live at `~/.jarvis/briefings/<kind-id>/<YYYY-MM-DD>-<slug>.md`.
 *
 * Skills generate new files by writing to the kind's directory. A
 * routine fires the skill on a cadence (any cadence — daily for
 * recaps, weekly for retros, etc.). The UI shows files sorted newest-
 * first per kind.
 *
 * Why "briefings" in the directory name when the primitive is
 * generic? It's the user-facing tab name and the first collection.
 * If we add a second collection later (e.g. "reports/"), it gets its
 * own DocCollection instance. The CODE shape stays identical.
 *
 * Electron-free. Future-portable to server mode.
 */

export interface DigestKind {
  /** Stable id, kebab-case ("daily-recap"). Also the subfolder name. */
  id: string;
  /** Display label ("Daily recap"). */
  label: string;
  /** One-line description shown under the label in the picker. */
  description: string;
  /** Skill id that generates a new file of this kind. */
  skillId: string;
  /** Suggested cron schedule — hint shown to the user. Real scheduling
   * lives in routines.json. */
  schedule?: string;
}

export interface DigestFile {
  /** Owning kind id. */
  kind: string;
  /** File name on disk, e.g. "2026-05-14-recap.md". */
  filename: string;
  /** Absolute path. */
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Pulled from frontmatter `title` if present, else filename. */
  title: string;
  /** Pulled from frontmatter `date` or YYYY-MM-DD prefix of filename. */
  date: string | null;
}

const ROOT = join(homedir(), '.jarvis', 'briefings');

export class BriefingsStore extends EventEmitter {
  private kinds: DigestKind[] = [];
  private watcher: FSWatcher | null = null;

  constructor(kinds: DigestKind[] = []) {
    super();
    this.kinds = kinds;
  }

  init(): void {
    // Ensure the root + each built-in kind's subdirectory exist so
    // skills can Write to a known path. mkdir -p is idempotent.
    mkdirSync(ROOT, { recursive: true });
    for (const k of this.kinds) {
      mkdirSync(join(ROOT, k.id), { recursive: true });
    }
    // Watch the whole tree. Emit 'changed' on add/change/unlink so the
    // renderer can refresh its list without polling.
    this.watcher = chokidar.watch(ROOT, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const ping = () => this.emit('changed');
    this.watcher.on('add', ping);
    this.watcher.on('change', ping);
    this.watcher.on('unlink', ping);
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
  }

  /** Return the registered kinds. Mostly static; new kinds need a
   * restart unless we wire a register() at runtime later. */
  listKinds(): DigestKind[] {
    return [...this.kinds];
  }

  registerKind(kind: DigestKind): void {
    const i = this.kinds.findIndex((k) => k.id === kind.id);
    if (i >= 0) this.kinds[i] = kind;
    else this.kinds.push(kind);
    mkdirSync(join(ROOT, kind.id), { recursive: true });
  }

  /** Files for a kind, newest first. */
  listFiles(kindId: string): DigestFile[] {
    const dir = join(ROOT, kindId);
    if (!existsSync(dir)) return [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DigestFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      try {
        const st = statSync(full);
        const meta = readFrontmatterSafely(full);
        out.push({
          kind: kindId,
          filename: entry.name,
          path: full,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
          title:
            (typeof meta.title === 'string' && meta.title.trim()) ||
            entry.name.replace(/\.md$/, ''),
          date:
            (typeof meta.date === 'string' && meta.date) ||
            extractDateFromName(entry.name),
        });
      } catch {
        // skip unreadable
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Read one file. Empty string if missing. */
  readFile(kindId: string, filename: string): string {
    // Defense in depth: filename must not escape the kind's directory.
    if (filename.includes('/') || filename.includes('..')) {
      throw new Error(`invalid filename: ${filename}`);
    }
    const path = join(ROOT, kindId, filename);
    if (!existsSync(path)) return '';
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  }

  /** Absolute path to a kind's directory — for skills to Write into. */
  dirOf(kindId: string): string {
    return join(ROOT, kindId);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function readFrontmatterSafely(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = matter(raw);
    return (parsed.data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractDateFromName(name: string): string | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}
