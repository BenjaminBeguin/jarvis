import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { app, ipcMain, shell } from 'electron';

import { IpcChannels } from '@shared/ipc';

import { getTrayMenuState } from '../tray.js';
import {
  hideAnswerHud,
  hideTrayMenu,
  openObservatory,
  openPalette,
  resizeAnswerHud,
  resizePalette,
  resizeTrayMenu,
  sendWhenReady,
  setAnswerHudInteractive,
} from '../windows.js';
import type { IpcDeps } from './types.js';
import type { TrayMenuState } from '@shared/types';

const execFileAsync = promisify(execFile);

export function registerWindowIpc(_deps: IpcDeps): void {
  ipcMain.handle(IpcChannels.openObservatory, (_e, taskId?: string) => {
    const win = openObservatory();
    win.focus();
    // The historical Observatory (task list + constellation + detail
    // pane) now lives under the `ai-agent` tab — the `observatory`
    // tab is the live FlowStream river, which doesn't surface a
    // specific task's transcript. Anything calling openObservatory
    // wants to *see* a task, so route to ai-agent.
    sendWhenReady(win, IpcChannels.shellNavigate, { tab: 'ai-agent' });
    if (typeof taskId === 'string' && taskId) {
      sendWhenReady(win, IpcChannels.observatoryFocusTask, taskId);
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

  ipcMain.handle(
    IpcChannels.setAnswerHudInteractive,
    (_e, interactive: boolean) => {
      setAnswerHudInteractive(!!interactive);
    },
  );

  ipcMain.handle(
    IpcChannels.trayMenuRead,
    (): TrayMenuState => getTrayMenuState(),
  );

  ipcMain.handle(IpcChannels.trayMenuHide, () => {
    hideTrayMenu();
  });

  ipcMain.handle(IpcChannels.trayMenuResize, (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) {
      resizeTrayMenu(height);
    }
  });

  ipcMain.handle(IpcChannels.trayMenuQuit, () => {
    app.quit();
  });

  ipcMain.handle(IpcChannels.openTab, (_e, tab: string) => {
    if (typeof tab !== 'string' || !tab) return;
    const win = openObservatory();
    win.focus();
    sendWhenReady(win, IpcChannels.shellNavigate, { tab });
  });

  ipcMain.handle(IpcChannels.openExternal, async (_e, url: string) => {
    // Only allow http/https. mailto + other schemes are easy XSS vectors when
    // the URL comes from rendered assistant content.
    if (typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  // Jump from a Jarvis task into Claude Code Desktop. Subscription-mode
  // sessions are real Claude Code sessions on disk (~/.claude/projects/...)
  // so Desktop already lists them in Recents — this just brings the app
  // forward. Claude Code Desktop doesn't register a `claude-code://` URL
  // scheme, so we use `open -a Claude` (and a few variant names) instead.
  // The `sessionId` arg is kept in case Desktop ever ships a deep-link
  // scheme; right now it's informational.
  ipcMain.handle(
    IpcChannels.openInClaudeDesktop,
    async (
      _e,
      _sessionId: string,
    ): Promise<{ ok: boolean; message?: string }> => {
      // Common bundle names Claude Code Desktop might ship as. We try in
      // order; the first one that exists on this machine wins. `open -a`
      // exits non-zero if the app isn't found, so we catch + try the next.
      const candidates = ['Claude', 'Claude Code', 'ClaudeCode'];
      for (const name of candidates) {
        try {
          await execFileAsync('open', ['-a', name]);
          return { ok: true, message: name };
        } catch {
          // try the next candidate
        }
      }
      return {
        ok: false,
        message:
          "Couldn't find Claude Code Desktop on this machine. Install it from claude.ai/download, or use the Copy resume command button to continue in a terminal.",
      };
    },
  );
}
