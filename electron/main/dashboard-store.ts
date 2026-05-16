import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { nanoid } from 'nanoid';

import type {
  DashboardConfig,
  DashboardItem,
  DashboardSection,
} from '@shared/types';

const VALID_ITEM_KINDS = new Set<DashboardItem['kind']>([
  'inbox',
  'routine',
  'calendar',
]);

function isDashboardItem(v: unknown): v is DashboardItem {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  if (typeof i.kind !== 'string') return false;
  if (!VALID_ITEM_KINDS.has(i.kind as DashboardItem['kind'])) return false;
  if (i.kind === 'routine' && typeof i.routineId !== 'string') return false;
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
 * Persistent store for the user-defined Dashboard layout. Writes to
 * `~/.jarvis/dashboard.json`. The renderer never edits the file directly
 * — it goes through IPC so the store can validate, normalize ids, and
 * broadcast changes.
 */
export class DashboardStore extends EventEmitter {
  readonly path: string;
  private cached: DashboardConfig = { sections: [] };

  constructor(path: string) {
    super();
    this.path = path;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      this.cached = defaultConfig();
      this.persist();
      return;
    }
    this.cached = this.load();
  }

  read(): DashboardConfig {
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
    this.cached = cleaned;
    this.persist();
    this.emit('changed', this.cached);
    return this.cached;
  }

  private load(): DashboardConfig {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
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
      console.warn(`failed to read dashboard.json — using defaults:`, err);
    }
    return defaultConfig();
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.cached, null, 2), 'utf8');
  }
}
