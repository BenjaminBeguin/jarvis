import { ipcMain } from 'electron';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';

import { IpcChannels } from '@shared/ipc';
import type { DispatchIntentResult, JarvisFileEntry } from '@shared/types';

import { hidePalette } from '../windows.js';
import type { IpcDeps } from './types.js';

export function registerModulesIpc({ modules, jarvisRoot }: IpcDeps): void {
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
}
