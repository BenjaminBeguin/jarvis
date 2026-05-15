import { ipcMain } from 'electron';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

/**
 * Inbox IPC: list (cheap, returns cached items) + refresh (re-runs every
 * source). Renderer fetches on tab open + on a manual refresh button.
 * Broadcasts `inbox:changed` whenever items update, `inbox:refreshing`
 * with bool so the spinner can fire from any window.
 *
 * `countInboxSource` + `clearInboxSource` let the Integrations page count
 * + delete the JSON inbox files a removed/disabled MCP populated. The
 * file name is a single segment ("slack-pulse.json"); path validation
 * blocks `..` and absolute paths.
 */
export function registerInboxIpc({ inbox, jarvisRoot }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listInbox, () => inbox.list());
  ipcMain.handle(IpcChannels.refreshInbox, () => inbox.refresh());
  ipcMain.handle(
    IpcChannels.dismissInboxItem,
    (_e, payload: { id: string; snoozeMs: number }) => {
      inbox.dismiss(payload.id, payload.snoozeMs);
    },
  );

  const inboxDir = join(jarvisRoot, 'inbox');
  const resolveInboxFile = (name: string): string | null => {
    // Single-segment filename only — block traversal + abs paths.
    if (!name || name.includes('/') || name.includes('..') || name.startsWith('.')) {
      return null;
    }
    const target = normalize(resolve(inboxDir, name));
    if (!target.startsWith(inboxDir)) return null;
    return target;
  };

  ipcMain.handle(
    IpcChannels.countInboxSource,
    (_e, name: string): { count: number; mtimeMs: number | null } => {
      const target = resolveInboxFile(name);
      if (!target || !existsSync(target)) return { count: 0, mtimeMs: null };
      try {
        const raw = readFileSync(target, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        let count = 0;
        if (Array.isArray(parsed)) count = parsed.length;
        else if (
          parsed && typeof parsed === 'object'
          && Array.isArray((parsed as { items?: unknown[] }).items)
        ) {
          count = (parsed as { items: unknown[] }).items.length;
        }
        return { count, mtimeMs: statSync(target).mtimeMs };
      } catch {
        return { count: 0, mtimeMs: null };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.clearInboxSource,
    async (_e, name: string): Promise<{ ok: boolean; message?: string }> => {
      const target = resolveInboxFile(name);
      if (!target) return { ok: false, message: 'Invalid inbox file name.' };
      if (!existsSync(target)) return { ok: true };
      try {
        unlinkSync(target);
        // Force a fresh refresh so the renderer + tray see the items
        // disappear without waiting for the auto-refresh tick.
        await inbox.refresh();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
