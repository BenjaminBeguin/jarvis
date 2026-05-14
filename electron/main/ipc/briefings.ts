import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import { asTaskOrigin } from '../task-runner.js';
import type { IpcDeps } from './types.js';

/**
 * Briefings IPC. List kinds, list files per kind, read a file's
 * markdown, generate a new file (fires the kind's skill).
 *
 * The kind's skill writes to `~/.jarvis/briefings/<kind-id>/<date>.md`
 * — see briefings.ts for the directory layout. The chokidar watcher
 * picks up the new file and broadcasts `briefingsChanged`.
 */
export function registerBriefingsIpc({ briefings, runner }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listBriefingKinds, () => briefings.listKinds());

  ipcMain.handle(IpcChannels.listBriefingFiles, (_e, kindId: string) =>
    briefings.listFiles(kindId),
  );

  ipcMain.handle(
    IpcChannels.readBriefingFile,
    (_e, payload: { kindId: string; filename: string }) =>
      briefings.readFile(payload.kindId, payload.filename),
  );

  // Generate on demand: launch the kind's skill via the runner. The
  // skill is responsible for writing the new file. We return the task
  // summary so the renderer can pop the Answer HUD and watch it.
  ipcMain.handle(IpcChannels.generateBriefing, (_e, kindId: string) => {
    const kind = briefings.listKinds().find((k) => k.id === kindId);
    if (!kind) {
      throw new Error(`Unknown briefing kind: ${kindId}`);
    }
    return runner.launch({
      prompt: `Generate the ${kind.label.toLowerCase()} now and save it under ~/.jarvis/briefings/${kind.id}/.`,
      skillId: kind.skillId,
      origin: asTaskOrigin('palette'),
    });
  });
}
