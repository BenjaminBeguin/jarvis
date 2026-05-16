import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IpcChannels } from '@shared/ipc';

import {
  loadAfkMode,
  loadPaused,
  saveAfkMode,
  savePaused,
} from './auth.js';
import { broadcast, openObservatory, openPalette, sendWhenReady, showAnswerHud } from './windows.js';

type AbortHandler = () => void;
let abortAllHandler: AbortHandler | null = null;
export function setAbortAllHandler(fn: AbortHandler): void {
  abortAllHandler = fn;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let tray: Tray | null = null;
let runningTasks = 0;
let pendingReminders = 0;
let awaitingReplies = 0;

function buildIcon(active: boolean): Electron.NativeImage {
  // Use template image so macOS handles dark/light. Falls back to a generated
  // 16x16 PNG so the tray still appears before assets are bundled.
  const filename = active ? 'tray-active.png' : 'tray-idle.png';
  const path = join(__dirname, '../../resources/icons', filename);
  const img = nativeImage.createFromPath(path);
  if (!img.isEmpty()) {
    img.setTemplateImage(true);
    return img;
  }
  // Fallback: 16x16 transparent placeholder dot.
  const dot = nativeImage.createFromBuffer(
    Buffer.from(
      // Minimal 16x16 PNG (transparent). Real icons replace this at build time.
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFklEQVR42mNkYGBgYBhFowKjAjQGADIQAA9Lc2WUAAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  dot.setTemplateImage(true);
  return dot;
}

function rebuildMenu(): void {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (runningTasks > 0) {
    items.push({ label: `● ${runningTasks} running`, enabled: false });
  }
  if (awaitingReplies > 0) {
    items.push({ label: `◐ ${awaitingReplies} awaiting reply`, enabled: false });
  }
  if (pendingReminders > 0) {
    items.push({ label: `⏰ ${pendingReminders} scheduled`, enabled: false });
  }
  if (items.length > 0) items.push({ type: 'separator' });
  // Tab shortcuts — broadcast shellNavigate so the renderer switches tab
  // after openObservatory brings the window forward.
  const openWithTab = (tab: 'observatory' | 'inbox' | 'routines') => {
    const win = openObservatory();
    win.focus();
    sendWhenReady(win, IpcChannels.shellNavigate, { tab });
  };
  items.push(
    { label: 'Open Observatory', click: () => openWithTab('observatory') },
    { label: 'Open Inbox', click: () => openWithTab('inbox') },
    { label: 'Open Routines', click: () => openWithTab('routines') },
    { type: 'separator' },
    { label: 'Open Palette  ⌘⇧J', click: () => openPalette() },
    { label: 'Show Answer HUD', click: () => showAnswerHud() },
    { type: 'separator' },
    {
      label: 'AFK mode (mirror to phone)',
      type: 'checkbox',
      checked: loadAfkMode(),
      click: (menuItem) => {
        const next = menuItem.checked;
        saveAfkMode(next);
        broadcast(IpcChannels.afkChanged, next);
        rebuildMenu();
      },
    },
    {
      label: 'Pause Jarvis (skip routines + scheduled actions)',
      type: 'checkbox',
      checked: loadPaused(),
      click: (menuItem) => {
        const next = menuItem.checked;
        savePaused(next);
        broadcast(IpcChannels.pausedChanged, next);
        rebuildMenu();
        // Also refresh the tray icon — paused state could later
        // gain visual treatment (dim icon, ⏸ tooltip badge).
        rebuildToolTip();
      },
    },
  );
  if (runningTasks > 0 && abortAllHandler) {
    items.push(
      { type: 'separator' },
      { label: `Abort all running (${runningTasks})`, click: () => abortAllHandler?.() },
    );
  }
  items.push({ type: 'separator' }, { role: 'quit' });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** Refresh the tray menu — exported so external AFK toggles (Settings UI,
 *  Telegram /afk command) can re-render the checkbox. */
export function refreshTrayMenu(): void {
  rebuildMenu();
}

function rebuildToolTip(): void {
  if (!tray) return;
  const bits: string[] = [];
  if (loadPaused()) bits.push('⏸ paused');
  if (runningTasks > 0) bits.push(`${runningTasks} running`);
  if (awaitingReplies > 0) bits.push(`${awaitingReplies} awaiting`);
  if (pendingReminders > 0) bits.push(`${pendingReminders} scheduled`);
  tray.setToolTip(bits.length ? `Jarvis — ${bits.join(' · ')}` : 'Jarvis');
}

export function initTray(): Tray {
  if (tray) return tray;
  tray = new Tray(buildIcon(false));
  rebuildToolTip();
  rebuildMenu();
  tray.on('click', () => openObservatory());
  return tray;
}

export function setRunningTasksCount(n: number): void {
  runningTasks = Math.max(0, n);
  if (!tray) return;
  tray.setImage(buildIcon(runningTasks > 0 || awaitingReplies > 0));
  rebuildToolTip();
  rebuildMenu();
}

export function setPendingRemindersCount(n: number): void {
  pendingReminders = Math.max(0, n);
  rebuildToolTip();
  rebuildMenu();
}

export function setAwaitingRepliesCount(n: number): void {
  awaitingReplies = Math.max(0, n);
  if (!tray) return;
  tray.setImage(buildIcon(runningTasks > 0 || awaitingReplies > 0));
  rebuildToolTip();
  rebuildMenu();
}

export function getRunningTasksCount(): number {
  return runningTasks;
}
