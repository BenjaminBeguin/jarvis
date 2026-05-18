import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerSummary } from '@shared/types';

/**
 * Disable state lives on the config entry itself — single source of truth
 * in mcp.json, no separate sidecar file. `disabledUntil` is a ms epoch;
 * when present and in the past, resolve() auto-clears the flag and the
 * server comes back online. `disabled:true` with no until = disabled
 * indefinitely.
 */
interface DisableMixin {
  disabled?: boolean;
  disabledUntil?: number;
}

type StdioConfig = DisableMixin & {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type SseConfig = DisableMixin & {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

type HttpConfig = DisableMixin & {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

/**
 * In-process MCP server provided by a managed integration (e.g. the
 * Gmail / Calendar wrappers spawned by the Google OAuth connector).
 * Lives in main-process memory only — never serialized to mcp.json,
 * never crosses IPC. The renderer doesn't see these in the "Installed"
 * list; they're rendered under "Connected accounts" instead.
 *
 * TaskRunner unwraps `instance` and passes it to the Agent SDK's
 * `mcpServers` option directly — same path the always-on `jarvis` MCP
 * uses.
 */
type SdkConfig = DisableMixin & {
  type: 'sdk';
  instance: McpSdkServerConfigWithInstance;
};

export type McpServerConfig = StdioConfig | SseConfig | HttpConfig | SdkConfig;

/** Is this server currently disabled? Treats expired disabledUntil as
 * "not disabled" — caller is responsible for persisting the cleared
 * state if they want to (resolve() does this lazily). */
function isCurrentlyDisabled(cfg: McpServerConfig, now: number): boolean {
  if (!cfg.disabled) return false;
  if (cfg.disabledUntil != null && cfg.disabledUntil <= now) return false;
  return true;
}

type RawConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown };
  return v.type === 'stdio' || v.type === 'sse' || v.type === 'http';
}

/**
 * The minimum surface mcp-config needs to overlay managed integration
 * entries on top of human-edited mcp.json. Implemented by IntegrationsStore.
 * Typed as an interface here to avoid a circular dependency.
 */
export interface ManagedMcpSource extends EventEmitter {
  allMcpEntries(): Record<string, McpServerConfig>;
}

export class McpConfigStore extends EventEmitter {
  private servers = new Map<string, McpServerConfig>();
  private watcher: FSWatcher | null = null;
  private managed: ManagedMcpSource | null = null;
  readonly path: string;

  constructor(path = join(homedir(), '.jarvis', 'mcp.json')) {
    super();
    this.path = path;
  }

  /** Attach a managed source (the IntegrationsStore). Its entries
   *  overlay mcp.json on every resolve(); changes to it re-emit our
   *  own 'changed' so consumers (renderer, runner) refresh. */
  setManagedSource(source: ManagedMcpSource): void {
    this.managed = source;
    source.on('changed', () => this.emit('changed', this.list()));
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
    const now = Date.now();
    const managedIds = this.managed
      ? new Set(Object.keys(this.managed.allMcpEntries()))
      : new Set<string>();
    return [...this.servers.entries()]
      .map(([id, cfg]) => ({
        id,
        type: cfg.type as 'stdio' | 'sse' | 'http',
        command: cfg.type === 'stdio' ? cfg.command : undefined,
        url:
          cfg.type === 'sse' || cfg.type === 'http' ? cfg.url : undefined,
        disabled: isCurrentlyDisabled(cfg, now),
        disabledUntil: cfg.disabledUntil ?? null,
        // When a connected integration publishes an MCP under the same
        // name, the mcp.json entry never reaches TaskRunner — flag it
        // so the renderer can offer a one-click cleanup.
        shadowedByManaged: managedIds.has(id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Combine hand-edited mcp.json entries with any managed overlay
   * (IntegrationsStore). Managed entries win on key conflict — if the
   * user has both a manual `slack` entry and a connected Slack account,
   * the managed one is what the runner sees. The Integrations UI shows
   * a warning so the user knows the manual entry is shadowed.
   */
  private mergedEntries(): Map<string, McpServerConfig> {
    const out = new Map<string, McpServerConfig>(this.servers);
    if (this.managed) {
      for (const [id, cfg] of Object.entries(this.managed.allMcpEntries())) {
        out.set(id, cfg);
      }
    }
    return out;
  }

  /**
   * Toggle the disabled state on an entry.
   *   - untilMs === null     → disabled indefinitely
   *   - untilMs === undefined → re-enable (clears the flag)
   *   - untilMs = epoch ms   → disabled until that timestamp
   *
   * No-op if the id doesn't exist. Persists on success.
   */
  setDisabled(id: string, untilMs: number | null | undefined): boolean {
    const cfg = this.servers.get(id);
    if (!cfg) return false;
    if (untilMs === undefined) {
      cfg.disabled = false;
      delete cfg.disabledUntil;
    } else {
      cfg.disabled = true;
      if (untilMs === null) delete cfg.disabledUntil;
      else cfg.disabledUntil = untilMs;
    }
    this.writeAll();
    return true;
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

  /**
   * Replace the entire config from a JSON string. Validates the shape
   * before writing — partial / malformed input is rejected so a stray
   * keystroke can't blow away the user's existing servers. Throws on
   * parse / shape errors.
   */
  replaceAll(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(
        `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Root must be an object with a "mcpServers" field.');
    }
    const raw = parsed as Record<string, unknown>;
    const entries = raw['mcpServers'];
    if (!entries || typeof entries !== 'object') {
      throw new Error('Missing or invalid "mcpServers" object.');
    }
    const next = new Map<string, McpServerConfig>();
    for (const [id, cfg] of Object.entries(entries as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
        throw new Error(`Invalid server id "${id}".`);
      }
      if (!isMcpServerConfig(cfg)) {
        throw new Error(
          `Entry "${id}" is missing a valid type (stdio / sse / http).`,
        );
      }
      next.set(id, cfg);
    }
    this.servers = next;
    this.writeAll();
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
    const now = Date.now();
    let clearedExpired = false;
    const merged = this.mergedEntries();
    const tryAdd = (id: string, cfg: McpServerConfig) => {
      // Auto-expire disabledUntil that's in the past so the entry comes
      // back online without manual intervention.
      if (cfg.disabled && cfg.disabledUntil != null && cfg.disabledUntil <= now) {
        cfg.disabled = false;
        delete cfg.disabledUntil;
        clearedExpired = true;
      }
      if (isCurrentlyDisabled(cfg, now)) return; // skip — paused by user
      out[id] = cfg;
    };
    // '*' opts the skill into every server in ~/.jarvis/mcp.json + every
    // managed integration so the user can add new ones without editing
    // every skill that wants them. Useful for omnibus skills like
    // `send` where the channel list is expected to grow.
    if (ids.includes('*')) {
      for (const [id, cfg] of merged.entries()) tryAdd(id, cfg);
    }
    for (const id of ids) {
      if (id === '*') continue;
      // Exact match first (manual mcp.json entry named e.g. "slack").
      const cfg = merged.get(id);
      if (cfg) tryAdd(id, cfg);
      // Also match any entry whose key starts with "<id>-" so a skill
      // requesting `mcp-servers: [slack]` picks up every managed
      // account, e.g. `slack-T0ABC`, `slack-T0DEF`. Mirrors how users
      // think about integrations ("Slack is connected") even though
      // each account gets its own MCP instance under the hood.
      const prefix = `${id}-`;
      for (const [entryId, entryCfg] of merged.entries()) {
        if (entryId === id) continue;
        if (entryId.startsWith(prefix)) tryAdd(entryId, entryCfg);
      }
    }
    if (clearedExpired) this.writeAll();
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
