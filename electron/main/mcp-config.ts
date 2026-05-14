import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import type { McpServerSummary } from '@shared/types';

type StdioConfig = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type SseConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

type HttpConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = StdioConfig | SseConfig | HttpConfig;

type RawConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown };
  return v.type === 'stdio' || v.type === 'sse' || v.type === 'http';
}

export class McpConfigStore extends EventEmitter {
  private servers = new Map<string, McpServerConfig>();
  private watcher: FSWatcher | null = null;
  readonly path: string;

  constructor(path = join(homedir(), '.jarvis', 'mcp.json')) {
    super();
    this.path = path;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.reload();
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const refresh = () => this.reload();
    this.watcher.on('add', refresh);
    this.watcher.on('change', refresh);
    this.watcher.on('unlink', () => {
      this.servers.clear();
      this.emit('changed', this.list());
    });
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
  }

  list(): McpServerSummary[] {
    return [...this.servers.entries()]
      .map(([id, cfg]) => ({
        id,
        type: cfg.type,
        command: cfg.type === 'stdio' ? cfg.command : undefined,
        url: cfg.type !== 'stdio' ? cfg.url : undefined,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Insert (or overwrite) a server entry. Persists the full file with the
   * other entries preserved. chokidar will pick up the change and emit
   * 'changed' on next reload — no need to do it inline.
   */
  upsert(id: string, cfg: McpServerConfig): void {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      throw new Error(
        `Invalid MCP server id "${id}". Use letters, digits, '-', '_'.`,
      );
    }
    this.servers.set(id, cfg);
    this.writeAll();
  }

  remove(id: string): boolean {
    if (!this.servers.has(id)) return false;
    this.servers.delete(id);
    this.writeAll();
    return true;
  }

  /** Read the on-disk file verbatim — used by the renderer to show it. */
  rawFileContents(): string | null {
    if (!existsSync(this.path)) return null;
    try {
      return readFileSync(this.path, 'utf8');
    } catch {
      return null;
    }
  }

  private writeAll(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const out: RawConfig = { mcpServers: {} };
    // Sort keys so diffs are stable across edits.
    const ids = [...this.servers.keys()].sort();
    for (const id of ids) {
      out.mcpServers![id] = this.servers.get(id)!;
    }
    writeFileSync(this.path, JSON.stringify(out, null, 2), 'utf8');
  }

  resolve(ids: string[]): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    // '*' opts the skill into every server in ~/.jarvis/mcp.json so the
    // user can add new ones without editing every skill that wants them.
    // Useful for omnibus skills like `send` where the channel list is
    // expected to grow.
    if (ids.includes('*')) {
      for (const [id, cfg] of this.servers.entries()) {
        out[id] = cfg;
      }
    }
    for (const id of ids) {
      if (id === '*') continue;
      const cfg = this.servers.get(id);
      if (cfg) out[id] = cfg;
    }
    return out;
  }

  private reload(): void {
    this.servers.clear();
    if (!existsSync(this.path)) {
      this.emit('changed', this.list());
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as RawConfig;
      const entries = parsed.mcpServers ?? {};
      for (const [id, cfg] of Object.entries(entries)) {
        if (isMcpServerConfig(cfg)) this.servers.set(id, cfg);
      }
    } catch (err) {
      console.warn(`failed to parse mcp.json:`, err);
    }
    this.emit('changed', this.list());
  }
}
