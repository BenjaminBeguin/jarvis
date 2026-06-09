import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { WorkspaceInput } from '@shared/types';

import {
  loadActiveWorkspaceId,
  saveActiveWorkspaceId,
} from '../auth.js';
import { setTrayWorkspace } from '../tray.js';
import type { IpcDeps } from './types.js';

/**
 * Workspaces IPC — list / create / update / delete + active selection.
 *
 * The active workspace id lives in `config.json` (single source of
 * truth) so it survives restarts; the store doesn't track it. Setting
 * it broadcasts `activeWorkspaceChanged` to every window so the
 * Bridge + Inbox + Activity views can re-render their scope without
 * polling.
 */
export function registerWorkspacesIpc({
  workspaces,
}: IpcDeps): void {
  ipcMain.handle(IpcChannels.listWorkspaces, () => workspaces.list());

  ipcMain.handle(
    IpcChannels.createWorkspace,
    (_e, input: WorkspaceInput) => workspaces.create(input),
  );

  ipcMain.handle(
    IpcChannels.updateWorkspace,
    (_e, payload: { id: string; input: WorkspaceInput }) =>
      workspaces.update(payload.id, payload.input),
  );

  ipcMain.handle(IpcChannels.deleteWorkspace, (_e, id: string) => {
    workspaces.remove(id);
    // If the deleted workspace was active, fall back to the default.
    if (loadActiveWorkspaceId() === id) {
      const next = workspaces.getDefault().id;
      saveActiveWorkspaceId(next);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IpcChannels.activeWorkspaceChanged, next);
      }
    }
    return true;
  });

  workspaces.on('changed', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.workspacesChanged, workspaces.list());
    }
  });

  ipcMain.handle(IpcChannels.getActiveWorkspace, () => {
    // Stored id may have been deleted out from under us — fall back
    // to the default workspace so the renderer never sees a dangling
    // reference.
    const stored = loadActiveWorkspaceId();
    if (stored && workspaces.get(stored)) return stored;
    return workspaces.getDefault().id;
  });

  ipcMain.handle(IpcChannels.setActiveWorkspace, (_e, id: string | null) => {
    // Validate the id exists before persisting — silently coerce
    // bad input to the default so the active id is never dangling.
    const target = id && workspaces.get(id) ? id : workspaces.getDefault().id;
    saveActiveWorkspaceId(target);
    // Tray title prefix updates in lockstep so the menu bar reflects
    // the new context immediately. Default workspace = no prefix.
    const def = workspaces.get(target);
    if (def) {
      setTrayWorkspace({
        label: def.icon ?? def.name.charAt(0).toUpperCase(),
        isDefault: def.default === true,
      });
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.activeWorkspaceChanged, target);
    }
    return target;
  });
}
