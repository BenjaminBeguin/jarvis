import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Per-project markdown memory living at
 * ~/.jarvis/projects/<name>/memory/. A growing scratchpad agents can
 * read at the start of a task and append to at the end so future agents
 * don't have to relearn the codebase every session.
 *
 * One file per topic. No magic — it's just markdown. The user can read,
 * edit, prune it freely.
 */

const ROOT = join(homedir(), '.jarvis', 'projects');

function safeName(name: string): string {
  // Same shape as elsewhere — kebab-case, no path separators.
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function safeFile(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+/, '')
    .slice(0, 96);
}

function memoryDir(project: string): string {
  const id = safeName(project);
  return join(ROOT, id, 'memory');
}

export interface MemoryFile {
  /** Logical file name (no extension stripping). */
  name: string;
  /** Absolute path. */
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export class ProjectMemoryStore {
  /** All memory files for a project, newest-first by mtime. */
  list(project: string): MemoryFile[] {
    const dir = memoryDir(project);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { withFileTypes: true });
    const out: MemoryFile[] = [];
    for (const e of entries) {
      if (e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      if (!e.name.endsWith('.md')) continue;
      try {
        const full = join(dir, e.name);
        const st = statSync(full);
        out.push({
          name: e.name,
          path: full,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        // skip unreadable
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Read one file's contents, or all files concatenated when file is omitted. */
  read(project: string, file?: string): string {
    const dir = memoryDir(project);
    if (!existsSync(dir)) return '';
    if (file) {
      const path = join(dir, safeFile(file));
      if (!existsSync(path)) return '';
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    }
    // Concat all .md files in mtime order, newest first.
    const files = this.list(project);
    if (files.length === 0) return '';
    return files
      .map((f) => `## ${f.name}\n\n${this.read(project, f.name)}`)
      .join('\n\n---\n\n');
  }

  /** Overwrite a single memory file. Use append for incremental notes. */
  write(project: string, file: string, content: string): string {
    const dir = memoryDir(project);
    mkdirSync(dirname(join(dir, '_')), { recursive: true });
    const path = join(dir, safeFile(file).endsWith('.md') ? safeFile(file) : `${safeFile(file)}.md`);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  append(project: string, file: string, content: string): string {
    const dir = memoryDir(project);
    mkdirSync(dirname(join(dir, '_')), { recursive: true });
    const name = safeFile(file).endsWith('.md') ? safeFile(file) : `${safeFile(file)}.md`;
    const path = join(dir, name);
    const sep = existsSync(path) ? '\n\n' : '';
    appendFileSync(path, sep + content, 'utf8');
    return path;
  }

  remove(project: string, file: string): boolean {
    const dir = memoryDir(project);
    const path = join(dir, safeFile(file));
    if (!existsSync(path)) return false;
    try {
      rmSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path to the project's memory directory — for agents to cd. */
  dir(project: string): string {
    return memoryDir(project);
  }
}
