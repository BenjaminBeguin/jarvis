import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import matter from 'gray-matter';

import type { SkillSummary } from '@shared/types';

import { asTier } from './model-tiers.js';

export interface SkillRecord extends SkillSummary {
  body: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  'allowed-tools'?: unknown;
  'mcp-servers'?: unknown;
  /** Explicit model id (e.g. 'claude-haiku-4-5'). Takes precedence
   *  over `tier` when both are set. Most skills should prefer
   *  `tier` so they participate in the global speed-bias system. */
  model?: string;
  /** Abstract tier: 'fast' / 'balanced' / 'smart'. Resolved to a
   *  concrete model via `model-tiers.ts:modelForTier`, with the
   *  user's `speedBias` preference applied on top. Unset → default
   *  tier (balanced) — so skills without any model hint still flow
   *  through the bias system. */
  tier?: string;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export class SkillStore extends EventEmitter {
  private readonly skills = new Map<string, SkillRecord>();
  private watcher: FSWatcher | null = null;
  readonly root: string;

  constructor(root = join(homedir(), '.jarvis', 'skills')) {
    super();
    this.root = root;
  }

  init(): void {
    mkdirSync(this.root, { recursive: true });
    this.reloadAll();
    this.watch();
  }

  list(): SkillSummary[] {
    return [...this.skills.values()]
      .map(({ body: _body, ...rest }) => rest)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): SkillRecord | undefined {
    return this.skills.get(id);
  }

  reloadAll(): void {
    this.skills.clear();
    const entries = existsSync(this.root)
      ? readdirSync(this.root, { withFileTypes: true })
      : [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(this.root, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const record = this.parseSkillFile(skillPath, entry.name);
      if (record) this.skills.set(record.id, record);
    }
    this.emit('changed', this.list());
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
  }

  private watch(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(`${this.root}/**/SKILL.md`, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const refresh = () => this.reloadAll();
    this.watcher.on('add', refresh);
    this.watcher.on('change', refresh);
    this.watcher.on('unlink', refresh);
    this.watcher.on('unlinkDir', refresh);
  }

  private parseSkillFile(filePath: string, dirName: string): SkillRecord | null {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const { data, content } = matter(raw);
      const fm = data as SkillFrontmatter;
      const name = String(fm.name ?? dirName).trim();
      const description = String(fm.description ?? '').trim();
      const allowedTools = toStringArray(fm['allowed-tools']);
      const mcpServers = toStringArray(fm['mcp-servers']);
      const model = typeof fm.model === 'string' ? fm.model : null;
      const tier = asTier(fm.tier);
      const body = content.trim();
      return {
        id: slugify(name) || slugify(dirName) || dirName,
        name,
        description,
        path: filePath,
        allowedTools,
        mcpServers,
        model,
        tier,
        hasBody: body.length > 0,
        body,
      };
    } catch (err) {
      console.warn(`failed to parse skill ${filePath}:`, err);
      return null;
    }
  }
}
