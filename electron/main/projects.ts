import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import type { ProjectDef } from '@shared/types';

interface PersistedProject {
  name?: string;
  aliases?: unknown;
  path?: string;
  repo?: string;
  description?: string;
}

interface PersistedFile {
  projects?: PersistedProject[];
}

function isPersistedProject(v: unknown): v is PersistedProject {
  return !!v && typeof v === 'object' && typeof (v as PersistedProject).name === 'string';
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export class ProjectStore extends EventEmitter {
  private projects: ProjectDef[] = [];
  private watcher: FSWatcher | null = null;
  readonly path: string;

  constructor(path = join(homedir(), '.jarvis', 'projects.json')) {
    super();
    this.path = path;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.reload();
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const refresh = () => this.reload();
    this.watcher.on('add', refresh);
    this.watcher.on('change', refresh);
    this.watcher.on('unlink', () => {
      this.projects = [];
      this.emit('changed', this.projects);
    });
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
  }

  list(): ProjectDef[] {
    return this.projects;
  }

  /**
   * Fuzzy-match a free-text query against project names + aliases +
   * description. Returns the best match or null if nothing fits. Used by
   * modules that want to scope an action to a project ("/note csai: foo",
   * "review my csai prs", etc.) without reimplementing the match logic.
   */
  resolve(query: string): ProjectDef | null {
    const q = query.toLowerCase().trim();
    if (!q) return null;
    // Exact name / alias match wins.
    for (const p of this.projects) {
      if (p.name.toLowerCase() === q) return p;
      if (p.aliases.some((a) => a.toLowerCase() === q)) return p;
    }
    // Substring fallback on name / aliases.
    for (const p of this.projects) {
      if (p.name.toLowerCase().includes(q)) return p;
      if (p.aliases.some((a) => a.toLowerCase().includes(q))) return p;
    }
    return null;
  }

  private reload(): void {
    if (!existsSync(this.path)) {
      this.projects = [];
      this.emit('changed', this.projects);
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      const persisted: PersistedFile = Array.isArray(raw) ? { projects: raw } : raw;
      const items = Array.isArray(persisted.projects) ? persisted.projects : [];
      this.projects = items.filter(isPersistedProject).map((p) => ({
        name: String(p.name).trim(),
        aliases: toStringArray(p.aliases),
        path: expandHome(p.path),
        repo: p.repo?.trim() || undefined,
        description: p.description?.trim() || undefined,
      }));
    } catch (err) {
      console.warn(`failed to parse projects.json:`, err);
      this.projects = [];
    }
    this.emit('changed', this.projects);
  }
}
