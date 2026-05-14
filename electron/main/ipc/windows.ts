import { ipcMain, shell } from 'electron';

import { IpcChannels } from '@shared/ipc';

import {
  hideAnswerHud,
  openObservatory,
  openPalette,
  resizeAnswerHud,
  resizePalette,
} from '../windows.js';
import type { IpcDeps } from './types.js';

export function registerWindowIpc(_deps: IpcDeps): void {
  ipcMain.handle(IpcChannels.openObservatory, (_e, taskId?: string) => {
    const win = openObservatory();
    win.focus();
    if (typeof taskId === 'string' && taskId) {
      const send = () =>
        win.webContents.send(IpcChannels.observatoryFocusTask, taskId);
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', send);
      } else {
        send();
      }
    }
  });

  ipcMain.handle(IpcChannels.openPalette, () => {
    openPalette();
  });

  ipcMain.handle(IpcChannels.resizePalette, (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) {
      resizePalette(height);
    }
  });

  ipcMain.handle(IpcChannels.showAnswerHud, (_e, taskId: string) => {
    if (typeof taskId !== 'string' || !taskId) return;
    _deps.hud.pushTask(taskId);
  });

  ipcMain.handle(IpcChannels.hideAnswerHud, () => {
    hideAnswerHud();
  });

  ipcMain.handle(IpcChannels.resizeAnswerHud, (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) {
      resizeAnswerHud(height);
    }
  });

  ipcMain.handle(IpcChannels.openExternal, async (_e, url: string) => {
    // Only allow http/https. mailto + other schemes are easy XSS vectors when
    // the URL comes from rendered assistant content.
    if (typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  // Jump from a Jarvis task into the Claude Code Desktop app on the same
  // session. Subscription-mode tasks ARE Claude Code sessions on disk, so
  // Desktop already knows about them — this is just a one-click launcher.
  // If Desktop hasn't registered the `claude-code://` URL scheme, openExternal
  // silently does nothing on macOS; we follow up with a plain `open -a Claude`
  // best-effort so the app at least comes to the foreground.
  ipcMain.handle(
    IpcChannels.openInClaudeDesktop,
    async (
      _e,
      sessionId: string,
    ): Promise<{ ok: boolean; message?: string }> => {
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, message: 'No session id.' };
      }
      try {
        await shell.openExternal(`claude-code://session/${sessionId}`);
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
