import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';

import type {
  DashboardConfig,
  DashboardItem,
  DashboardSection,
} from '@shared/types';

const VALID_ITEM_KINDS = new Set<DashboardItem['kind']>([
  'inbox',
  'drafts',
  'inbox-source',
  'routine',
  'calendar',
  'spend',
]);

function isDashboardItem(v: unknown): v is DashboardItem {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  if (typeof i.kind !== 'string') return false;
  if (!VALID_ITEM_KINDS.has(i.kind as DashboardItem['kind'])) return false;
  if (i.kind === 'routine' && typeof i.routineId !== 'string') return false;
  if (i.kind === 'inbox-source' && typeof i.source !== 'string') return false;
  return true;
}

const VALID_MAX_HEIGHTS = new Set(['auto', 'compact', 'medium', 'tall']);

function isDashboardSection(v: unknown): v is DashboardSection {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== 'string' || typeof s.title !== 'string') return false;
  if (!Array.isArray(s.items)) return false;
  if (
    s.width !== undefined &&
    s.width !== 'full' &&
    s.width !== 'half'
  ) {
    return false;
  }
  if (
    s.maxHeight !== undefined &&
    (typeof s.maxHeight !== 'string' ||
      !VALID_MAX_HEIGHTS.has(s.maxHeight))
  ) {
    return false;
  }
  return s.items.every(isDashboardItem);
}

/**
 * Default layout for new installs / missing config. Two sections: the
 * always-on Inbox at the top, then an empty "My briefings" the user
 * populates by toggling routines onto it. Tracks what the user asked
 * for in conversation; not something they need to configure first time.
 */
function defaultConfig(): DashboardConfig {
  return {
    sections: [
      {
        id: nanoid(8),
        title: 'Inbox',
        items: [{ kind: 'inbox' }],
      },
      {
        id: nanoid(8),
        title: 'My briefings',
        items: [],
      },
    ],
  };
}

/**
 * Persistent store for the user-defined Dashboard layout.
 *
 * Workspace-aware: each workspace gets its own layout file under
 * `~/.jarvis/dashboards/<workspaceId>.json`. The store keeps the
 * **active workspace's** config in memory and reloads when the
 * workspace switches. On first read for a new workspace the store
 * seeds from `~/.jarvis/dashboard.json` (legacy single-config file)
 * when present, otherwise from `defaultConfig()`. The legacy file
 * stays on disk so pre-Phase-3 users always have a fall-back; it
 * isn't deleted by the migration so a rollback path exists.
 *
 * The renderer never edits the file directly — it goes through IPC
 * so the store can validate, normalize ids, and broadcast changes.
 */
export class DashboardStore extends EventEmitter {
  readonly path: string; // legacy single-file path (back-compat read seed)
  private readonly rootDir: string;
  private workspaceResolver: (() => string | null) | null = null;
  private cached: DashboardConfig = { sections: [] };
  private cachedKey: string | null = null;

  constructor(legacyPath: string) {
    super();
    this.path = legacyPath;
    // `~/.jarvis/dashboards/` — one file per workspace lives here.
    // Sibling to the legacy single-file path so users grepping ~/.jarvis
    // for "dashboard" find both. Kept as a directory so adding a new
    // workspace doesn't need a migration write — the file is created
    // lazily on first save.
    this.rootDir = join(dirname(legacyPath), 'dashboards');
  }

  /** Wire the resolver right after WorkspaceStore.init() in bootstrap.
   *  Reloads cache + emits 'changed' so the renderer re-fetches. */
  setWorkspaceResolver(fn: () => string | null): void {
    this.workspaceResolver = fn;
    // Force a reload so the cache reflects the workspace's file —
    // boot path hits this immediately after wiring.
    this.reload();
  }

  init(): void {
    mkdirSync(this.rootDir, { recursive: true });
    // First call: resolver not wired yet → fall back to legacy file.
    this.reload();
  }

  /** Reload from disk for the currently-active workspace and emit
   *  'changed' so the renderer re-fetches. Called on boot, after the
   *  resolver is wired, and whenever the active workspace switches. */
  reload(): void {
    const key = this.workspaceKey();
    const path = this.pathFor(key);
    if (existsSync(path)) {
      this.cached = this.loadPath(path);
    } else if (existsSync(this.path)) {
      // First time this workspace asks for its file — seed from the
      // legacy single-config and persist so subsequent edits don't
      // bleed back into the legacy file (which other workspaces would
      // also still seed from).
      this.cached = this.loadPath(this.path);
      writeFileSync(path, JSON.stringify(this.cached, null, 2), 'utf8');
    } else {
      this.cached = defaultConfig();
      writeFileSync(path, JSON.stringify(this.cached, null, 2), 'utf8');
    }
    this.cachedKey = key;
    this.emit('changed', this.cached);
  }

  read(): DashboardConfig {
    // Resolve lazily so a workspace switch between events doesn't
    // serve stale state. Cheap — string compare + (possibly) a single
    // read.
    const key = this.workspaceKey();
    if (key !== this.cachedKey) this.reload();
    return this.cached;
  }

  /** Overwrite the entire config — used when the renderer drags / renames /
   * reorders. Validates each section + item; rejects bad shape outright
   * so a malformed save can't poison the file. */
  write(next: DashboardConfig): DashboardConfig {
    const cleaned: DashboardConfig = {
      sections: (next?.sections ?? [])
        .filter(isDashboardSection)
        .map((s) => ({
          id: s.id || nanoid(8),
          title: s.title.trim() || 'Untitled',
          items: s.items.filter(isDashboardItem),
          ...(s.width ? { width: s.width } : {}),
          // maxHeight 'auto' is the default — drop the field entirely
          // so the persisted JSON stays clean (only sections that opt
          // in carry a value).
          ...(s.maxHeight && s.maxHeight !== 'auto'
            ? { maxHeight: s.maxHeight }
            : {}),
        })),
    };
    const key = this.workspaceKey();
    this.cached = cleaned;
    this.cachedKey = key;
    writeFileSync(
      this.pathFor(key),
      JSON.stringify(this.cached, null, 2),
      'utf8',
    );
    this.emit('changed', this.cached);
    return this.cached;
  }

  /** Resolve the active workspace key (or '_default_' when no resolver
   *  is wired yet — happens during bootstrap before
   *  setWorkspaceResolver runs). */
  private workspaceKey(): string {
    const id = this.workspaceResolver?.();
    return id && id.trim() ? id : '_default_';
  }

  private pathFor(key: string): string {
    return join(this.rootDir, `${key}.json`);
  }

  private loadPath(p: string): DashboardConfig {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (
        raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as Record<string, unknown>).sections)
      ) {
        const sections = (raw as { sections: unknown[] }).sections.filter(
          isDashboardSection,
        );
        return { sections };
      }
    } catch (err) {
      console.warn(`failed to read ${p} — using defaults:`, err);
    }
    return defaultConfig();
  }
}
