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

import preferencesTemplate from './seeds/preferences-template.js';

/**
 * Loads + watches `~/.jarvis/preferences.md` — the user's "operating manual"
 * prepended to every task's system prompt by TaskRunner.
 *
 * Seeded with a sensible default on first launch only. Subsequent edits
 * (from the in-app editor or from disk directly) are observed via chokidar
 * and broadcast to renderers so the UI stays in sync.
 *
 * Electron-free — survives a future move to server-mode.
 */
export class PreferencesStore extends EventEmitter {
  private cached = '';
  private watcher: FSWatcher | null = null;
  /** Per-workspace overlay files live at
   *  `~/.jarvis/workspaces/<id>/preferences.md`. They APPEND to the
   *  base preferences (not replace) so the user can keep a "global
   *  tone" baseline + add workspace-specific nuance ("formal in Work",
   *  "casual in Personal"). */
  private overlayRoot: string;
  private overlayWatcher: FSWatcher | null = null;
  /** Resolver for the active workspace id. When set, `readOverlay()`
   *  consults the workspace's preferences.md and includes it in
   *  `readFull()`. Wired from index.ts after WorkspaceStore inits. */
  private workspaceResolver: (() => string | null) | null = null;
  readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
    this.overlayRoot = join(homedir(), '.jarvis', 'workspaces');
  }

  setWorkspaceResolver(fn: () => string | null): void {
    this.workspaceResolver = fn;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      writeFileSync(this.path, preferencesTemplate, 'utf8');
    }
    this.reload();
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const refresh = () => this.reload();
    this.watcher.on('add', refresh);
    this.watcher.on('change', refresh);
    this.watcher.on('unlink', () => {
      this.cached = '';
      this.emit('changed', this.cached);
    });
    // Workspace overlay watcher — broadcast 'changed' when any
    // `~/.jarvis/workspaces/<id>/preferences.md` changes so the
    // renderer's Settings editor + the TaskRunner re-read.
    mkdirSync(this.overlayRoot, { recursive: true });
    this.overlayWatcher = chokidar.watch(
      join(this.overlayRoot, '*', 'preferences.md'),
      {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      },
    );
    const onOverlay = () => this.emit('changed', this.cached);
    this.overlayWatcher.on('add', onOverlay);
    this.overlayWatcher.on('change', onOverlay);
    this.overlayWatcher.on('unlink', onOverlay);
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
    void this.overlayWatcher?.close();
    this.overlayWatcher = null;
  }

  /** Workspace overlay path for the given id (or null when no
   *  workspace is active). Public so Settings UI can show / edit. */
  overlayPathFor(workspaceId: string): string {
    return join(this.overlayRoot, workspaceId, 'preferences.md');
  }

  /** Read the active workspace's overlay file. Returns empty string
   *  when no workspace is active, no resolver is set, or the file
   *  doesn't exist. */
  readOverlay(workspaceId?: string | null): string {
    const id = workspaceId ?? this.workspaceResolver?.();
    if (!id) return '';
    const p = this.overlayPathFor(id);
    if (!existsSync(p)) return '';
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      console.warn(`failed to read overlay preferences ${p}:`, err);
      return '';
    }
  }

  /** Persist a workspace overlay. Caller passes the workspace id +
   *  the markdown body. Empty body clears the file. */
  writeOverlay(workspaceId: string, content: string): void {
    const p = this.overlayPathFor(workspaceId);
    mkdirSync(dirname(p), { recursive: true });
    if (!content.trim()) {
      // Empty save = remove the overlay (it's an additive layer; an
      // empty file would still trigger a useless ## heading).
      if (existsSync(p)) {
        try {
          writeFileSync(p, '', 'utf8');
        } catch {
          /* swallow */
        }
      }
      return;
    }
    writeFileSync(p, content, 'utf8');
  }

  /** Current file contents (cached). Empty string if the file is missing. */
  read(): string {
    return this.cached;
  }

  /**
   * Write new contents to disk. Chokidar will then fire the change event
   * which updates the cache + notifies subscribers — keeps the source of
   * truth on disk (one path, no drift).
   */
  write(content: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, content, 'utf8');
  }

  private reload(): void {
    try {
      this.cached = existsSync(this.path)
        ? readFileSync(this.path, 'utf8')
        : '';
    } catch (err) {
      console.warn('failed to read preferences.md:', err);
      this.cached = '';
    }
    this.emit('changed', this.cached);
  }
}
