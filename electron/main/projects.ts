import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import type { ProjectDef, ProjectInput } from '@shared/types';

interface PersistedProject {
  name?: string;
  workspaceId?: string;
  aliases?: unknown;
  path?: string;
  repo?: string;
  repos?: unknown;
  keywords?: unknown;
  description?: string;
  inboxScan?: boolean;
}

/** Normalise an unknown-shaped list field (repos / keywords) into a
 *  clean, deduplicated `string[]` (or `undefined` if empty). Strings
 *  separated by commas / newlines are accepted too, so users can type
 *  comma-separated values into the textarea without us having to
 *  pre-parse on every write site. */
function normaliseList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  let raw: unknown[];
  if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string') raw = value.split(/[\n,]/);
  else return undefined;
  const cleaned = raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  if (cleaned.length === 0) return undefined;
  return [...new Set(cleaned)];
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
      workspaceId: input.workspaceId?.trim() || undefined,
      aliases,
      path: input.path?.trim() || undefined,
      repo: input.repo?.trim() || undefined,
      repos: normaliseList(input.repos),
      keywords: normaliseList(input.keywords),
      description: input.description?.trim() || undefined,
      inboxScan: input.inboxScan,
    };
    this.projects = [...this.projects, def];
    this.writeAll();
    this.emit('changed', this.projects);
    return def;
  }

  /**
   * Update an existing project in-place. Keyed by the CURRENT name
   * (which may be in `input.name` if renaming, or omitted to keep the
   * existing name). All other fields fall back to the existing values
   * when undefined in `input` — so the caller can pass a partial patch.
   * Returns the updated def; throws if the project doesn't exist.
   */
  update(currentName: string, input: ProjectInput): ProjectDef {
    const i = this.projects.findIndex(
      (p) => p.name.toLowerCase() === currentName.toLowerCase(),
    );
    if (i < 0) throw new Error(`Project "${currentName}" not found`);
    const existing = this.projects[i]!;
    const nextName = input.name?.trim() || existing.name;
    // Block name collisions with a different existing project.
    if (
      nextName.toLowerCase() !== existing.name.toLowerCase() &&
      this.projects.some(
        (p, idx) => idx !== i && p.name.toLowerCase() === nextName.toLowerCase(),
      )
    ) {
      throw new Error(`Project "${nextName}" already exists`);
    }
    const def: ProjectDef = {
      name: nextName,
      workspaceId:
        input.workspaceId !== undefined
          ? input.workspaceId.trim() || undefined
          : existing.workspaceId,
      aliases:
        input.aliases !== undefined
          ? input.aliases.map((a) => a.trim()).filter(Boolean)
          : existing.aliases,
      path: input.path !== undefined ? input.path.trim() || undefined : existing.path,
      repo: input.repo !== undefined ? input.repo.trim() || undefined : existing.repo,
      repos: input.repos !== undefined ? normaliseList(input.repos) : existing.repos,
      keywords:
        input.keywords !== undefined
          ? normaliseList(input.keywords)
          : existing.keywords,
      description:
        input.description !== undefined
          ? input.description.trim() || undefined
          : existing.description,
      inboxScan: input.inboxScan !== undefined ? input.inboxScan : existing.inboxScan,
    };
    this.projects[i] = def;
    this.writeAll();
    this.emit('changed', this.projects);
    return def;
  }

  /** Delete a project by name. Throws if it doesn't exist. The project's
   * on-disk memory directory is left in place — the user can clean it
   * up manually if they want a fresh start. */
  remove(name: string): void {
    const i = this.projects.findIndex(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (i < 0) throw new Error(`Project "${name}" not found`);
    this.projects.splice(i, 1);
    this.writeAll();
    this.emit('changed', this.projects);
  }

  /**
   * Toggle whether a project's repo gets scanned by the PR inbox sources.
   * Persisted as `inboxScan` on the project entry in projects.json.
   * No-op if the project doesn't exist.
   */
  setInboxScan(name: string, enabled: boolean): void {
    const i = this.projects.findIndex(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (i < 0) return;
    this.projects[i] = { ...this.projects[i]!, inboxScan: enabled };
    this.writeAll();
    this.emit('changed', this.projects);
  }

  /** Serialise the current in-memory projects to projects.json. */
  private writeAll(): void {
    const next: PersistedFile = {
      projects: this.projects.map((p) => ({
        name: p.name,
        workspaceId: p.workspaceId,
        aliases: p.aliases,
        path: p.path,
        repo: p.repo,
        repos: p.repos,
        keywords: p.keywords,
        description: p.description,
        inboxScan: p.inboxScan,
      })),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2) + '\n', 'utf8');
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
        workspaceId: p.workspaceId?.trim() || undefined,
        aliases: toStringArray(p.aliases),
        path: expandHome(p.path),
        repo: p.repo?.trim() || undefined,
        repos: normaliseList(p.repos),
        keywords: normaliseList(p.keywords),
        description: p.description?.trim() || undefined,
        inboxScan: typeof p.inboxScan === 'boolean' ? p.inboxScan : undefined,
      }));
    } catch (err) {
      console.warn(`failed to parse projects.json:`, err);
      this.projects = [];
    }
    this.emit('changed', this.projects);
  }
}
