import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import type { WorkflowDef } from '@shared/types';

/**
 * Loads + watches `~/.jarvis/workflows/*.json`. Validates the shape
 * loosely (id, name, trigger, pipeline are required). Bad JSON files
 * are surfaced via the `loadErrors` field on the snapshot rather than
 * thrown — keeps the rest of the store usable when one file is broken.
 *
 * Persists user edits via `save()`. The chokidar watcher picks up
 * external edits (manual file changes, the seeder dropping new
 * files) and re-emits 'changed' without an app restart.
 */

const DEFAULT_ROOT = join(homedir(), '.jarvis', 'workflows');

interface PersistedWorkflow {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  trigger?: unknown;
  pipeline?: unknown;
}

export interface WorkflowLoadError {
  filename: string;
  message: string;
}

export class WorkflowStore extends EventEmitter {
  readonly root: string;
  private workflows = new Map<string, WorkflowDef>();
  private loadErrors: WorkflowLoadError[] = [];
  private watcher: FSWatcher | null = null;

  constructor(root: string = DEFAULT_ROOT) {
    super();
    this.root = root;
  }

  init(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    this.reloadAll();
    this.watch();
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
  }

  list(): WorkflowDef[] {
    return [...this.workflows.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  get(id: string): WorkflowDef | null {
    return this.workflows.get(id) ?? null;
  }

  errors(): WorkflowLoadError[] {
    return [...this.loadErrors];
  }

  /**
   * Persist a workflow definition. Creates or replaces the file at
   * `<root>/<id>.json`. The chokidar watcher will pick up the change
   * + re-emit 'changed' — we don't double-emit here.
   */
  save(def: WorkflowDef): void {
    if (!def.id || typeof def.id !== 'string') {
      throw new Error('Workflow id is required');
    }
    if (!/^[a-z0-9-]+$/i.test(def.id)) {
      throw new Error(
        `Workflow id "${def.id}" must be alphanumeric + dashes only`,
      );
    }
    const path = join(this.root, `${def.id}.json`);
    const body = JSON.stringify(def, null, 2) + '\n';
    writeFileSync(path, body, 'utf8');
    // Update the in-memory copy synchronously so callers don't have
    // to wait for the watcher debounce.
    this.workflows.set(def.id, def);
    this.emit('changed', this.list());
  }

  remove(id: string): boolean {
    const path = join(this.root, `${id}.json`);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      this.workflows.delete(id);
      this.emit('changed', this.list());
      return true;
    } catch {
      return false;
    }
  }

  private reloadAll(): void {
    this.workflows.clear();
    this.loadErrors = [];
    if (!existsSync(this.root)) {
      this.emit('changed', this.list());
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      this.emit('changed', this.list());
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (entry.name.startsWith('.')) continue;
      const path = join(this.root, entry.name);
      try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as PersistedWorkflow;
        const def = this.validate(entry.name, parsed);
        if (def) this.workflows.set(def.id, def);
      } catch (err) {
        this.loadErrors.push({
          filename: entry.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.emit('changed', this.list());
  }

  private validate(
    filename: string,
    raw: PersistedWorkflow,
  ): WorkflowDef | null {
    if (typeof raw.id !== 'string' || !raw.id) {
      this.loadErrors.push({ filename, message: 'missing id' });
      return null;
    }
    if (typeof raw.name !== 'string' || !raw.name) {
      this.loadErrors.push({ filename, message: 'missing name' });
      return null;
    }
    if (!raw.trigger || typeof raw.trigger !== 'object') {
      this.loadErrors.push({ filename, message: 'missing trigger' });
      return null;
    }
    if (!Array.isArray(raw.pipeline)) {
      this.loadErrors.push({ filename, message: 'pipeline must be an array' });
      return null;
    }
    const trigger = raw.trigger as { kind?: unknown };
    if (trigger.kind !== 'cron' && trigger.kind !== 'manual') {
      this.loadErrors.push({
        filename,
        message: `trigger.kind must be cron or manual, got ${String(trigger.kind)}`,
      });
      return null;
    }
    // Pipeline node-shape check is light: require .type to be a string.
    const pipeline: WorkflowDef['pipeline'] = (
      raw.pipeline as Array<Record<string, unknown>>
    )
      .filter((n) => typeof n.type === 'string' && n.type)
      .map((n) => ({
        type: n.type as string,
        params:
          typeof n.params === 'object' && n.params !== null
            ? (n.params as Record<string, unknown>)
            : {},
        ...(n.optional === true ? { optional: true } : {}),
      }));
    return {
      id: raw.id,
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      enabled: raw.enabled !== false,
      trigger: raw.trigger as WorkflowDef['trigger'],
      pipeline,
    };
  }

  private watch(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(`${this.root}/*.json`, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const refresh = (): void => this.reloadAll();
    this.watcher.on('add', refresh);
    this.watcher.on('change', refresh);
    this.watcher.on('unlink', refresh);
  }
}
