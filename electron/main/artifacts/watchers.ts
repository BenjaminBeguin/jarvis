import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, sep } from 'node:path';

import type { ArtifactInput } from '@shared/types';

import { deleteArtifact, upsertArtifact } from './registry.js';

/**
 * Chokidar watchers over Jarvis-owned markdown directories. Catches
 * out-of-band edits (user opens a note in VS Code, daily-learn skill
 * writes inferred-priorities.md, etc.) and keeps the artifact index
 * in lockstep.
 *
 * Reuses the chokidar pattern from briefings.ts / skill-store.ts.
 *
 * Three watch roots, one watcher each so we can stop them in isolation:
 *   - ~/.jarvis/meetings
 *   - ~/.jarvis/notes
 *   - ~/.jarvis/briefings
 *
 * Project-memory is not watched here; its writes always go through
 * the ProjectMemoryStore which calls registerArtifact directly.
 */

const watchers: FSWatcher[] = [];

export function startArtifactWatchers(): void {
  const root = join(homedir(), '.jarvis');
  startWatcher(join(root, 'meetings'), 'meeting');
  startWatcher(join(root, 'notes'), 'note');
  startWatcher(join(root, 'briefings'), 'briefing');
}

export function stopArtifactWatchers(): void {
  for (const w of watchers) void w.close().catch(() => {});
  watchers.length = 0;
}

function startWatcher(rootDir: string, kind: string): void {
  if (!existsSync(rootDir)) return;
  const watcher = chokidar.watch(rootDir, {
    persistent: true,
    ignoreInitial: true, // backfill handles the existing files
    depth: 4,
    ignored: (path) => basename(path).startsWith('.'),
    awaitWriteFinish: {
      // Markdown saves are atomic-ish on macOS but vim's swap dance
      // can fire `add` + `change` rapidly. Wait for things to settle.
      stabilityThreshold: 500,
      pollInterval: 200,
    },
  });
  watcher
    .on('add', (p) => handle(p, rootDir, kind))
    .on('change', (p) => handle(p, rootDir, kind))
    .on('unlink', (p) => handleDelete(p, rootDir, kind))
    .on('error', (err) => {
      console.warn(`[artifacts:watcher] ${kind}`, err);
    });
  watchers.push(watcher);
}

function handle(path: string, rootDir: string, kind: string): void {
  if (extname(path).toLowerCase() !== '.md') return;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.warn(`[artifacts:watcher] read ${path} failed`, err);
    return;
  }
  const { meta, body } = parseFrontmatter(raw);
  const rel = relative(rootDir, path);
  const segments = rel.split(sep);
  // Convention: if the file is in a subdirectory directly under the
  // root, that subdirectory is the project slug.
  const project =
    typeof meta['project'] === 'string'
      ? (meta['project'] as string)
      : segments.length > 1
        ? segments[0] ?? null
        : null;
  const slug = rel.replace(/[\\/]/g, '__').replace(/\.md$/i, '');
  const title =
    typeof meta['title'] === 'string' && meta['title']
      ? (meta['title'] as string)
      : basename(path, '.md');

  const input: ArtifactInput = {
    id: `${kind}:${slug}`,
    kind,
    title,
    project,
    path,
    url: `vscode://file${path}`,
    frontmatter: meta as Record<string, unknown>,
    content: body,
    createdAt: stat.birthtimeMs || stat.mtimeMs,
  };
  void upsertArtifact(input).catch((err) => {
    console.warn(`[artifacts:watcher] upsert ${path} failed`, err);
  });
}

function handleDelete(path: string, rootDir: string, kind: string): void {
  if (extname(path).toLowerCase() !== '.md') return;
  const rel = relative(rootDir, path);
  const slug = rel.replace(/[\\/]/g, '__').replace(/\.md$/i, '');
  deleteArtifact(`${kind}:${slug}`);
}

function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) meta[k] = v;
  }
  return { meta, body: match[2] ?? '' };
}
