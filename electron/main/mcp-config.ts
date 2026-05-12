import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

  resolve(ids: string[]): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const id of ids) {
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
