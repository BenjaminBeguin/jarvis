import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ConnectorAccount, ConnectorId } from '@shared/types';

import type { ConnectorRegistry } from './oauth/connector-registry.js';
import type { McpServerConfig } from './mcp-config.js';

interface RawFile {
  version: 1;
  accounts: ConnectorAccount[];
  defaults: Partial<Record<ConnectorId, string>>;
}

/**
 * Persists ~/.jarvis/integrations.json. Holds account *metadata* —
 * tokens never come anywhere near this file (they live in Keychain).
 *
 * Emits `'changed'` whenever the on-disk state changes. McpConfigStore
 * subscribes so managed entries appear/disappear in `resolve()` output
 * the instant an account lands or gets disconnected.
 */
export class IntegrationsStore extends EventEmitter {
  private file: RawFile = { version: 1, accounts: [], defaults: {} };
  /** Resolver for the active workspace id. When set, `allMcpEntries()`
   *  filters out accounts tagged to other workspaces — only accounts
   *  whose workspaceId matches the active id (or is null = global)
   *  contribute MCP entries. Wired from index.ts at boot. */
  private workspaceResolver: (() => string | null) | null = null;

  constructor(
    private readonly path: string,
    private registry: ConnectorRegistry | null = null,
  ) {
    super();
  }

  /** Registry is set after construction because the orchestrator + store
   *  + registry have a circular construction order. Resetting is fine —
   *  managed MCP entries are derived per-call. */
  setRegistry(registry: ConnectorRegistry): void {
    this.registry = registry;
  }

  setWorkspaceResolver(fn: () => string | null): void {
    this.workspaceResolver = fn;
  }

  /** Update an account's workspaceId tag. null = global. Emits
   *  'changed' so the MCP overlay re-resolves and the Integrations
   *  UI reflects the new assignment. */
  setAccountWorkspace(
    accountId: string,
    workspaceId: string | null,
  ): boolean {
    const idx = this.file.accounts.findIndex((a) => a.id === accountId);
    if (idx < 0) return false;
    const existing = this.file.accounts[idx]!;
    if ((existing.workspaceId ?? null) === workspaceId) return false;
    this.file.accounts[idx] = { ...existing, workspaceId };
    this.write();
    this.emit('changed');
    return true;
  }

  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      this.write();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (isRawFile(parsed)) {
        this.file = parsed;
      } else {
        console.warn(
          `[integrations] ${this.path}: malformed file, starting fresh.`,
        );
      }
    } catch (err) {
      console.warn(`[integrations] failed to read ${this.path}:`, err);
    }
  }

  list(): ConnectorAccount[] {
    return [...this.file.accounts];
  }

  get(accountId: string): ConnectorAccount | null {
    return this.file.accounts.find((a) => a.id === accountId) ?? null;
  }

  /** Upsert by `id` — if an account with the same id already exists,
   *  it's replaced (handles re-auth on the same provider account). */
  upsert(account: ConnectorAccount): void {
    const idx = this.file.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
      this.file.accounts[idx] = account;
    } else {
      this.file.accounts.push(account);
      // First account of a connector becomes the default automatically.
      if (!this.file.defaults[account.connectorId]) {
        this.file.defaults[account.connectorId] = account.id;
      }
    }
    this.write();
    this.emit('changed');
  }

  update(accountId: string, patch: Partial<ConnectorAccount>): boolean {
    const idx = this.file.accounts.findIndex((a) => a.id === accountId);
    if (idx < 0) return false;
    const merged = { ...this.file.accounts[idx]!, ...patch, id: accountId };
    this.file.accounts[idx] = merged;
    this.write();
    this.emit('changed');
    return true;
  }

  remove(accountId: string): boolean {
    const before = this.file.accounts.length;
    const removed = this.file.accounts.find((a) => a.id === accountId);
    if (!removed) return false;
    this.file.accounts = this.file.accounts.filter((a) => a.id !== accountId);
    // If we just removed the default, promote the next available account
    // for that connector (or clear the default entirely).
    if (this.file.defaults[removed.connectorId] === accountId) {
      const next = this.file.accounts.find(
        (a) => a.connectorId === removed.connectorId,
      );
      if (next) this.file.defaults[removed.connectorId] = next.id;
      else delete this.file.defaults[removed.connectorId];
    }
    if (this.file.accounts.length !== before) {
      this.write();
      this.emit('changed');
      return true;
    }
    return false;
  }

  setDefault(connectorId: ConnectorId, accountId: string | null): boolean {
    if (accountId === null) {
      if (!(connectorId in this.file.defaults)) return false;
      delete this.file.defaults[connectorId];
      this.write();
      this.emit('changed');
      return true;
    }
    const account = this.file.accounts.find((a) => a.id === accountId);
    if (!account || account.connectorId !== connectorId) return false;
    if (this.file.defaults[connectorId] === accountId) return false;
    this.file.defaults[connectorId] = accountId;
    this.write();
    this.emit('changed');
    return true;
  }

  defaultFor(connectorId: ConnectorId): string | null {
    return this.file.defaults[connectorId] ?? null;
  }

  /**
   * Aggregate every managed MCP entry across all accounts. Called by
   * McpConfigStore.resolve() to overlay these on top of human-edited
   * mcp.json entries.
   *
   * For each account, the connector decides:
   *   - which server name(s) to materialize (e.g. `slack-T123` plus
   *     `slack` alias for the default)
   *   - what config (command, args, env) each entry holds
   *
   * Phase 1: every connector returns `{}` (no real provider yet), so
   * this overlay is empty until phase 2.
   */
  allMcpEntries(): Record<string, McpServerConfig> {
    if (!this.registry) return {};
    const out: Record<string, McpServerConfig> = {};
    const activeWorkspace = this.workspaceResolver?.() ?? null;
    // Workspace filter: when a workspace is active, drop accounts
    // tagged to a DIFFERENT workspace. Accounts with null workspaceId
    // are "global" — visible everywhere. When NO workspace is active
    // (boot-time / early reads), all accounts contribute, preserving
    // legacy behaviour.
    const visible = this.file.accounts.filter((a) => {
      if (!activeWorkspace) return true;
      const tag = a.workspaceId ?? null;
      if (!tag) return true;
      return tag === activeWorkspace;
    });
    for (const account of visible) {
      const connector = this.registry.get(account.connectorId);
      if (!connector) continue;
      const entries = connector.mcpEntries(account);
      for (const [id, cfg] of Object.entries(entries)) {
        out[id] = cfg;
      }
      // Default account also publishes a "bare prefix" alias for every
      // entry it owns, so skills can opt in with `mcp-servers: [gmail]`
      // and reach the default Google account's Gmail MCP instead of
      // typing the full `gmail-ben@example.com`. The convention: an
      // entry named `<prefix>-<rest>` exposes itself as `<prefix>` too.
      // First default wins on conflict (per the existing iteration
      // order — connectors registered earlier shadow later ones).
      //
      // When two accounts in the same workspace are both connected
      // (e.g. user has two Work Slack workspaces), the `default`
      // pointer decides which gets the bare alias — same rule as
      // before, just workspace-scoped via the filter above.
      if (this.file.defaults[account.connectorId] === account.id) {
        for (const [id, cfg] of Object.entries(entries)) {
          const dashIdx = id.indexOf('-');
          if (dashIdx <= 0) continue;
          const prefix = id.slice(0, dashIdx);
          if (!/^[a-z][a-z0-9]*$/.test(prefix)) continue;
          if (!(prefix in out)) out[prefix] = cfg;
        }
      }
    }
    return out;
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2), 'utf8');
  }
}

function isRawFile(v: unknown): v is RawFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1) return false;
  if (!Array.isArray(o['accounts'])) return false;
  if (!o['defaults'] || typeof o['defaults'] !== 'object') return false;
  return true;
}
