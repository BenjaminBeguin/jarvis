import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { join, normalize, relative, resolve } from 'node:path';

import { IpcChannels } from '@shared/ipc';
import type {
  DispatchIntentResult,
  JarvisFileEntry,
  ModuleSettingsValues,
} from '@shared/types';

import { hidePalette } from '../windows.js';
import type { IpcDeps } from './types.js';

export function registerModulesIpc({ modules, activity, jarvisRoot }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listModules, () => modules.list());

  ipcMain.handle(
    IpcChannels.dispatchIntent,
    async (
      _e,
      { moduleId, intentId, input }: { moduleId: string; intentId: string; input: string },
    ): Promise<DispatchIntentResult> => {
      const result = await modules.dispatch(moduleId, intentId, input);
      if (result.ok) hidePalette();
      return result;
    },
  );

  ipcMain.handle(
    IpcChannels.setModuleEnabled,
    async (_e, { moduleId, enabled }: { moduleId: string; enabled: boolean }) => {
      await modules.setEnabled(moduleId, enabled);
      // History pipe: every module toggle becomes a row in the Activity
      // feed and the module's own history pane in Settings → Modules. The
      // dotted kind `module.<state>` matches the convention used by other
      // sources (note.created, meeting.started, etc.).
      activity.record({
        kind: enabled ? 'module.enabled' : 'module.disabled',
        label: `Module ${enabled ? 'enabled' : 'disabled'} · ${moduleId}`,
        detail: { moduleId },
      });
    },
  );

  ipcMain.handle(
    IpcChannels.writeModuleSettings,
    (
      _e,
      payload: { moduleId: string; values: ModuleSettingsValues },
    ): { ok: boolean; message?: string } => {
      if (!payload || typeof payload.moduleId !== 'string') {
        return { ok: false, message: 'Invalid moduleId.' };
      }
      const ok = modules.writeSettings(payload.moduleId, payload.values ?? {});
      if (ok) {
        // We don't diff the values here — just record that they changed.
        // The new values are queryable via listModules() afterwards.
        activity.record({
          kind: 'module.settings-changed',
          label: `Settings changed · ${payload.moduleId}`,
          detail: { moduleId: payload.moduleId, values: payload.values ?? {} },
        });
      }
      return ok
        ? { ok: true }
        : { ok: false, message: 'Module has no settings schema.' };
    },
  );

  // ~/.jarvis directory browser (read-only). Used by the Observatory's
  // "Jarvis dir" inspector. Path-traversal guarded against jarvisRoot.
  const resolveSafe = (rel: string): string => {
    const target = normalize(resolve(jarvisRoot, rel || '.'));
    const within = relative(jarvisRoot, target);
    if (within.startsWith('..') || within === '..') {
      throw new Error(`Path escapes ~/.jarvis: ${rel}`);
    }
    return target;
  };

  ipcMain.handle(
    IpcChannels.listJarvisDir,
    (_e, rel: string): JarvisFileEntry[] => {
      const target = resolveSafe(rel);
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(target, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: JarvisFileEntry[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = join(target, entry.name);
        try {
          const stat = statSync(full);
          out.push({
            name: entry.name,
            isDir: entry.isDirectory(),
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
          });
        } catch {
          // skip unreadable
        }
      }
      return out;
    },
  );

  ipcMain.handle(IpcChannels.readJarvisFile, (_e, rel: string): string => {
    const target = resolveSafe(rel);
    return readFileSync(target, 'utf8');
  });

  /**
   * Write a file under ~/.jarvis. Used by the catalog config-file editor
   * (slack-watchlist.md, team.md, …) so the user can edit per-integration
   * config from inside the app. Creates parent directories if needed.
   * Path is validated via resolveSafe — can't escape ~/.jarvis.
   */
  ipcMain.handle(
    IpcChannels.writeJarvisFile,
    (
      _e,
      payload: { path: string; contents: string },
    ): { ok: boolean; message?: string } => {
      try {
        if (typeof payload?.path !== 'string' || !payload.path) {
          return { ok: false, message: 'Invalid path.' };
        }
        if (typeof payload.contents !== 'string') {
          return { ok: false, message: 'Contents must be a string.' };
        }
        const target = resolveSafe(payload.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, payload.contents, 'utf8');
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Native folder picker — used by the palette session-config chip to pick
  // extra directories the agent can read/write beyond cwd.
  ipcMain.handle(
    IpcChannels.pickDirectory,
    async (
      e,
      options?: { multi?: boolean; defaultPath?: string },
    ): Promise<string[]> => {
      const sender = BrowserWindow.fromWebContents(e.sender);
      const props: Array<'openDirectory' | 'multiSelections'> = ['openDirectory'];
      if (options?.multi) props.push('multiSelections');
      const result = sender
        ? await dialog.showOpenDialog(sender, {
            properties: props,
            defaultPath: options?.defaultPath,
          })
        : await dialog.showOpenDialog({
            properties: props,
            defaultPath: options?.defaultPath,
          });
      if (result.canceled) return [];
      return result.filePaths;
    },
  );
}
