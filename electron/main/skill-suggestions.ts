import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';

import type { SkillSuggestion, SkillSuggestionStatus } from '@shared/types';

interface BatchProposal {
  name: string;
  description: string;
  body: string;
  samplePrompts?: string[];
  frequency?: number;
}

function safeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function isBatchProposal(v: unknown): v is BatchProposal {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.name === 'string' &&
    typeof r.description === 'string' &&
    typeof r.body === 'string'
  );
}

function isPersisted(v: unknown): v is SkillSuggestion {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.description === 'string' &&
    typeof r.body === 'string' &&
    typeof r.createdAt === 'number'
  );
}

/**
 * Owns ~/.jarvis/skill-suggestions.json. Watches a sibling drop file
 * (~/.jarvis/.skill-batch.json) — when the skill-author task writes its
 * proposals there, this store ingests them (assigning ids + timestamps)
 * and deletes the batch file. Keeps Claude's responsibilities tiny: it
 * just needs to write JSON to a known path; merge + dedupe + persist
 * lives here.
 */
export class SkillSuggestionStore extends EventEmitter {
  private suggestions: SkillSuggestion[] = [];
  private watcher: FSWatcher | null = null;
  readonly path: string;
  readonly batchPath: string;
  readonly skillsDir: string;

  constructor(jarvisRoot: string) {
    super();
    this.path = join(jarvisRoot, 'skill-suggestions.json');
    this.batchPath = join(jarvisRoot, '.skill-batch.json');
    this.skillsDir = join(jarvisRoot, 'skills');
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.load();
    this.startWatching();
    // Pick up any batch file that landed while we weren't running.
    if (existsSync(this.batchPath)) this.ingestBatch();
  }

  list(): SkillSuggestion[] {
    return [...this.suggestions].sort((a, b) => b.createdAt - a.createdAt);
  }

  pendingCount(): number {
    return this.suggestions.filter((s) => s.status === 'pending').length;
  }

  /**
   * Write the proposed SKILL.md to ~/.jarvis/skills/<name>/SKILL.md.
   * Refuses to overwrite an existing skill so an accidental Accept can't
   * clobber a hand-edited skill — caller can dismiss + re-suggest with a
   * different name.
   */
  accept(id: string): { ok: boolean; message?: string; path?: string } {
    const s = this.suggestions.find((x) => x.id === id);
    if (!s) return { ok: false, message: 'Suggestion not found' };
    if (s.status !== 'pending') {
      return { ok: false, message: `Already ${s.status}` };
    }
    const dir = join(this.skillsDir, s.name);
    const path = join(dir, 'SKILL.md');
    if (existsSync(path)) {
      return {
        ok: false,
        message: `~/.jarvis/skills/${s.name}/SKILL.md already exists — rename or dismiss`,
      };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, s.body, 'utf8');
    s.status = 'accepted';
    this.persist();
    this.emit('changed', this.list());
    return { ok: true, path };
  }

  dismiss(id: string): boolean {
    const s = this.suggestions.find((x) => x.id === id);
    if (!s || s.status !== 'pending') return false;
    s.status = 'dismissed';
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  remove(id: string): boolean {
    const before = this.suggestions.length;
    this.suggestions = this.suggestions.filter((s) => s.id !== id);
    if (this.suggestions.length === before) return false;
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  close(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Ingest the drop file. Validates each proposal, fills in id/createdAt/
   * status='pending', appends to the store, deletes the batch file. Skips
   * proposals whose `name` would collide with an existing pending or
   * already-accepted suggestion (no dupes in the panel).
   */
  private ingestBatch(): void {
    if (!existsSync(this.batchPath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.batchPath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Bad JSON from the skill — surface as an emit so the UI/dev can see.
      this.emit('error', new Error(`Invalid JSON in ${this.batchPath}`));
      try {
        rmSync(this.batchPath);
      } catch {
        // ignore
      }
      return;
    }
    const proposals: BatchProposal[] = Array.isArray(parsed)
      ? parsed.filter(isBatchProposal)
      : [];
    let added = 0;
    for (const p of proposals) {
      const name = safeName(p.name);
      if (!name) continue;
      const alreadyHere = this.suggestions.some(
        (s) => s.name === name && s.status !== 'dismissed',
      );
      if (alreadyHere) continue;
      const suggestion: SkillSuggestion = {
        id: nanoid(8),
        name,
        description: p.description,
        body: p.body,
        samplePrompts: Array.isArray(p.samplePrompts)
          ? p.samplePrompts.filter((x): x is string => typeof x === 'string').slice(0, 8)
          : [],
        frequency: typeof p.frequency === 'number' ? p.frequency : 1,
        createdAt: Date.now(),
        status: 'pending',
      };
      this.suggestions.push(suggestion);
      added++;
    }
    try {
      rmSync(this.batchPath);
    } catch {
      // ignore
    }
    if (added > 0) {
      this.persist();
      this.emit('changed', this.list());
      this.emit('batch', { added });
    }
  }

  private startWatching(): void {
    this.watcher = chokidar.watch(this.batchPath, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher.on('add', () => this.ingestBatch());
    this.watcher.on('change', () => this.ingestBatch());
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!isPersisted(item)) continue;
      this.suggestions.push({
        id: item.id,
        name: item.name,
        description: item.description,
        body: item.body,
        samplePrompts: Array.isArray(item.samplePrompts) ? item.samplePrompts : [],
        frequency: typeof item.frequency === 'number' ? item.frequency : 1,
        createdAt: item.createdAt,
        status: ((['pending', 'accepted', 'dismissed'] as SkillSuggestionStatus[]).includes(
          item.status as SkillSuggestionStatus,
        )
          ? item.status
          : 'pending') as SkillSuggestionStatus,
      });
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.suggestions, null, 2));
  }
}
