import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import type { WorkspaceDef, WorkspaceInput } from '@shared/types';

/**
 * WorkspaceStore — top-level grouping above projects.
 *
 * Persistence: `~/.jarvis/workspaces.json`. Single JSON file holding
 * the WorkspaceDef array; mirrors the ProjectStore shape so the
 * Settings UI + IPC handlers can reuse the same patterns.
 *
 * One workspace is always flagged `default: true`. The seeder
 * creates `personal` on first boot if no file exists, so the runtime
 * invariant "there's at least one workspace, exactly one of which is
 * default" always holds.
 *
 * Chokidar-watched so external edits (the user opens workspaces.json
 * in a text editor) live-update without restart.
 */

interface PersistedWorkspace {
  id?: string;
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  default?: boolean;
}

interface PersistedFile {
  workspaces?: PersistedWorkspace[];
}

const DEFAULT_WORKSPACE: WorkspaceDef = {
  id: 'personal',
  name: 'Personal',
  description: 'Default workspace — your catch-all home.',
  color: '#6ee7ff',
  icon: '◎',
  default: true,
};

export class WorkspaceStore extends EventEmitter {
  private workspaces: WorkspaceDef[] = [];
  private watcher: FSWatcher | null = null;
  readonly path: string;

  constructor(path = join(homedir(), '.jarvis', 'workspaces.json')) {
    super();
    this.path = path;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      // First-run: seed the Personal default. Without this the rest
      // of the app would have no "fall-through" workspace for items
      // whose workspaceId is null.
      this.workspaces = [DEFAULT_WORKSPACE];
      this.writeAll();
    } else {
      this.reload();
    }
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    this.watcher.on('change', () => this.reload());
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
  }

  list(): WorkspaceDef[] {
    return [...this.workspaces];
  }

  get(id: string): WorkspaceDef | null {
    return this.workspaces.find((w) => w.id === id) ?? null;
  }

  /** The workspace flagged default — never null after init() because
   *  the seeder guarantees one. Used as the fall-through resolver
   *  for any read that expects a workspace. */
  getDefault(): WorkspaceDef {
    return (
      this.workspaces.find((w) => w.default) ??
      this.workspaces[0] ??
      DEFAULT_WORKSPACE
    );
  }

  create(input: WorkspaceInput): WorkspaceDef {
    const id = (input.id ?? slugify(input.name)).trim();
    if (!id) throw new Error('Workspace id required');
    if (this.workspaces.some((w) => w.id === id)) {
      throw new Error(`Workspace "${id}" already exists`);
    }
    const def: WorkspaceDef = {
      id,
      name: input.name.trim() || id,
      description: input.description?.trim() || undefined,
      color: input.color?.trim() || undefined,
      icon: input.icon?.trim() || undefined,
      default: input.default === true,
    };
    // Maintain the invariant: at most one default.
    if (def.default) {
      this.workspaces = this.workspaces.map((w) => ({ ...w, default: false }));
    }
    this.workspaces.push(def);
    this.writeAll();
    this.emit('changed', this.workspaces);
    return def;
  }

  update(id: string, input: WorkspaceInput): WorkspaceDef {
    const i = this.workspaces.findIndex((w) => w.id === id);
    if (i < 0) throw new Error(`Workspace "${id}" not found`);
    const existing = this.workspaces[i]!;
    const def: WorkspaceDef = {
      id: existing.id,
      name: input.name?.trim() || existing.name,
      description:
        input.description !== undefined
          ? input.description.trim() || undefined
          : existing.description,
      color:
        input.color !== undefined
          ? input.color.trim() || undefined
          : existing.color,
      icon:
        input.icon !== undefined
          ? input.icon.trim() || undefined
          : existing.icon,
      default: input.default !== undefined ? input.default : existing.default,
    };
    if (def.default && !existing.default) {
      // Demote any previous default.
      this.workspaces = this.workspaces.map((w) => ({ ...w, default: false }));
    }
    this.workspaces[i] = def;
    this.writeAll();
    this.emit('changed', this.workspaces);
    return def;
  }

  remove(id: string): void {
    const i = this.workspaces.findIndex((w) => w.id === id);
    if (i < 0) throw new Error(`Workspace "${id}" not found`);
    if (this.workspaces[i]!.default) {
      throw new Error(`Cannot delete the default workspace`);
    }
    if (this.workspaces.length === 1) {
      throw new Error(`Cannot delete the only workspace`);
    }
    this.workspaces.splice(i, 1);
    this.writeAll();
    this.emit('changed', this.workspaces);
  }

  private writeAll(): void {
    const next: PersistedFile = {
      workspaces: this.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        color: w.color,
        icon: w.icon,
        default: w.default,
      })),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }

  private reload(): void {
    if (!existsSync(this.path)) {
      this.workspaces = [DEFAULT_WORKSPACE];
      this.writeAll();
      this.emit('changed', this.workspaces);
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      const persisted: PersistedFile = Array.isArray(raw) ? { workspaces: raw } : raw;
      const items = Array.isArray(persisted.workspaces) ? persisted.workspaces : [];
      const parsed: WorkspaceDef[] = items
        .filter(
          (w): w is PersistedWorkspace =>
            !!w && typeof w === 'object' && typeof w.id === 'string',
        )
        .map<WorkspaceDef>((w) => ({
          id: String(w.id).trim(),
          name: String(w.name ?? w.id).trim(),
          description: w.description?.trim() || undefined,
          color: w.color?.trim() || undefined,
          icon: w.icon?.trim() || undefined,
          default: w.default === true,
        }))
        .filter((w) => !!w.id);
      // Invariant: at least one workspace + exactly one default.
      if (parsed.length === 0) {
        this.workspaces = [DEFAULT_WORKSPACE];
        this.writeAll();
      } else {
        const hasDefault = parsed.some((w) => w.default);
        if (!hasDefault) parsed[0]!.default = true;
        // If multiple are flagged default, keep the first, demote the rest.
        let sawDefault = false;
        for (const w of parsed) {
          if (w.default) {
            if (sawDefault) w.default = false;
            else sawDefault = true;
          }
        }
        this.workspaces = parsed;
      }
    } catch (err) {
      console.warn(`failed to parse workspaces.json:`, err);
      this.workspaces = [DEFAULT_WORKSPACE];
    }
    this.emit('changed', this.workspaces);
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
