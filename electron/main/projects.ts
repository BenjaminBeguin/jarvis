import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import type { ProjectDef, ProjectInput } from '@shared/types';

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
   * Append a project to projects.json. Writes the file back as a clean JSON
   * object (we lose comments in the original file, but this format is
   * user-edited rarely once seeded). Throws on duplicate name (case-insensitive)
   * or invalid name.
   */
  create(input: ProjectInput): ProjectDef {
    const name = input.name.trim();
    if (!name) throw new Error('Project name is required');
    const lower = name.toLowerCase();
    if (this.projects.some((p) => p.name.toLowerCase() === lower)) {
      throw new Error(`Project "${name}" already exists`);
    }
    const aliases = (input.aliases ?? [])
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    // Auto-add a short alias (lowercase, no spaces) when the user didn't
    // bother typing one — most palette flows match against aliases.
    const auto = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (auto && auto !== lower && !aliases.includes(auto)) {
      aliases.push(auto);
    }
    const def: ProjectDef = {
      name,
      aliases,
      path: input.path?.trim() || undefined,
      repo: input.repo?.trim() || undefined,
      description: input.description?.trim() || undefined,
    };
    const next: PersistedFile = {
      projects: [...this.projects, def].map((p) => ({
        name: p.name,
        aliases: p.aliases,
        path: p.path,
        repo: p.repo,
        description: p.description,
      })),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    // The chokidar watcher will pick this up and emit 'changed', but apply
    // it eagerly too so the caller's next list() is correct.
    this.projects = [...this.projects, def];
    this.emit('changed', this.projects);
    return def;
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
