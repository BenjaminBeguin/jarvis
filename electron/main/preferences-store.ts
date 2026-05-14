import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
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
  readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
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
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
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
