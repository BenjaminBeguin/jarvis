import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IpcChannels } from '@shared/ipc';

import type { AppMode, TaskStatus, TrayMenuState } from '@shared/types';

import {
  loadAfkMode,
  loadAppMode,
  saveAfkMode,
  saveAppMode,
} from './auth.js';
import {
  broadcast,
  hideTrayMenu,
  openObservatory,
  openPalette,
  sendWhenReady,
  showTrayMenu,
  surfaceConversation,
} from './windows.js';

/** Lightweight shape pushed from the renderer for each pinned tab.
 *  Mirrors the renderer's ConvoEntry but only the fields the tray
 *  needs — keeps the wire format small. */
export interface PinnedConversationEntry {
  taskId: string;
  title: string;
  status: TaskStatus;
  /** True when the conversation is currently reduced to a chip
   *  rather than visible in the sidebar. Drives the menu glyph. */
  reduced: boolean;
}

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
/** Today's Jarvis spend in USD. Refreshed by setTodaySpend() from
 *  index.ts on a short cadence so the tray reflects current cost
 *  without forcing the renderer to do it. Hidden when 0 — no point
 *  showing "$0.00 today" 23 hours of the day. */
let todaySpendUsd = 0;
let reducedConversations = 0;
/** Pinned conversations pushed from the renderer. The tray surfaces
 *  these as a submenu so the user can jump back to anything they
 *  pinned without having to bring Jarvis forward first. */
let pinnedConversations: PinnedConversationEntry[] = [];

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

function statusGlyph(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return '●'; // active
    case 'queued':
      return '◔';
    case 'completed':
      return '✓';
    case 'aborted':
      return '⊘';
    case 'errored':
      return '⚠';
  }
}

/** Route a tray-menu conversation click — see surfaceConversation
 *  in windows.ts for the focused-vs-popup branching. */
function focusConversation(taskId: string): void {
  surfaceConversation(taskId);
}

/** Last-built native menu, popped manually on right-click as the
 *  accessibility fallback. We deliberately don't attach it via
 *  setContextMenu — macOS would auto-show it on left-click and
 *  conflict with the custom popover. */
let nativeMenu: Electron.Menu | null = null;

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

  if (pinnedConversations.length > 0) {
    items.push({
      label: `📌 Pinned · ${pinnedConversations.length}`,
      enabled: false,
    });
    for (const p of pinnedConversations) {
      const glyph = statusGlyph(p.status);
      const trail = p.reduced ? '  ▸ chip' : '';
      // Truncate long titles so the menu stays narrow.
      const title = p.title.length > 48 ? p.title.slice(0, 47) + '…' : p.title;
      items.push({
        label: `${glyph}  ${title}${trail}`,
        click: () => focusConversation(p.taskId),
      });
    }
    items.push({ type: 'separator' });
  }
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
    { type: 'separator' },
    ...buildModeRadios(),
  );
  if (runningTasks > 0 && abortAllHandler) {
    items.push(
      { type: 'separator' },
      { label: `Abort all running (${runningTasks})`, click: () => abortAllHandler?.() },
    );
  }
  items.push({ type: 'separator' }, { role: 'quit' });
  nativeMenu = Menu.buildFromTemplate(items);
}

/** Refresh the tray menu — exported so external AFK toggles (Settings UI,
 *  Telegram /afk command) can re-render the checkbox. */
export function refreshTrayMenu(): void {
  rebuildMenu();
  broadcastTrayState();
}

/**
 * Three-radio submenu for the tri-state appMode. Selecting an item
 * writes the new mode, broadcasts both `appModeChanged` and the
 * legacy `pausedChanged`, then rebuilds the tray + tooltip.
 */
function buildModeRadios(): Electron.MenuItemConstructorOptions[] {
  const current = loadAppMode();
  const item = (
    mode: AppMode,
    label: string,
  ): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: current === mode,
    click: () => {
      if (loadAppMode() === mode) return;
      saveAppMode(mode);
      broadcast(IpcChannels.appModeChanged, mode);
      broadcast(IpcChannels.pausedChanged, mode === 'paused');
      rebuildMenu();
      rebuildToolTip();
    },
  });
  return [
    item('paused', '⏸ Paused — silence routines + scheduled actions'),
    item('running', '▶ Running'),
    item('autopilot', '⚡ Autopilot — act on incoming asks'),
  ];
}

function rebuildToolTip(): void {
  if (!tray) return;
  const bits: string[] = [];
  const mode = loadAppMode();
  if (mode === 'paused') bits.push('⏸ paused');
  else if (mode === 'autopilot') bits.push('⚡ autopilot');
  if (runningTasks > 0) bits.push(`${runningTasks} running`);
  if (awaitingReplies > 0) bits.push(`${awaitingReplies} awaiting`);
  if (pendingReminders > 0) bits.push(`${pendingReminders} scheduled`);
  if (reducedConversations > 0) {
    bits.push(`💬 ${reducedConversations} reduced`);
  }
  if (pinnedConversations.length > 0) {
    bits.push(`📌 ${pinnedConversations.length} pinned`);
  }
  if (todaySpendUsd > 0) {
    bits.push(
      `$${todaySpendUsd >= 0.01 ? todaySpendUsd.toFixed(2) : todaySpendUsd.toFixed(4)} today`,
    );
  }
  tray.setToolTip(bits.length ? `Jarvis — ${bits.join(' · ')}` : 'Jarvis');
}

/**
 * Update the visible text the tray shows in the macOS menu bar.
 * Without this the bundled PNGs may be missing in dev → the icon
 * is invisible. The title is intentionally tiny: a "J" base, with
 * status badges appended when there's something to surface.
 */
function rebuildTitle(): void {
  if (!tray) return;
  const parts = ['J'];
  if (runningTasks > 0) parts.push(`●${runningTasks}`);
  if (pinnedConversations.length > 0) {
    parts.push(`📌${pinnedConversations.length}`);
  }
  tray.setTitle(parts.join(' '));
}

export function initTray(): Tray {
  if (tray) return tray;
  tray = new Tray(buildIcon(false));
  rebuildTitle();
  rebuildToolTip();
  rebuildMenu();
  // Left-click → custom Jarvis-styled popover. The native context
  // menu is popped on right-click as an accessibility fallback
  // (VoiceOver / arrow-key nav). We deliberately don't call
  // setContextMenu — that would auto-show the native menu on
  // left-click and clash with the custom popover.
  tray.on('click', (_event, bounds) => {
    showTrayMenu({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  });
  tray.on('right-click', () => {
    if (nativeMenu && tray) tray.popUpContextMenu(nativeMenu);
  });
  return tray;
}

/** Snapshot the bits the custom tray menu needs. Single source of
 *  truth for both the initial `trayMenuRead` IPC and broadcast
 *  pushes on change. */
export function getTrayMenuState(): TrayMenuState {
  return {
    appMode: loadAppMode(),
    afk: loadAfkMode(),
    runningTasks,
    awaitingReplies,
    pendingReminders,
    reducedConversations,
    todaySpendUsd,
    pinned: [...pinnedConversations],
  };
}

function broadcastTrayState(): void {
  broadcast(IpcChannels.trayMenuStateChanged, getTrayMenuState());
}

export function setRunningTasksCount(n: number): void {
  runningTasks = Math.max(0, n);
  if (!tray) return;
  tray.setImage(buildIcon(runningTasks > 0 || awaitingReplies > 0));
  rebuildTitle();
  rebuildToolTip();
  rebuildMenu();
  broadcastTrayState();
}

export function setPendingRemindersCount(n: number): void {
  pendingReminders = Math.max(0, n);
  rebuildToolTip();
  rebuildMenu();
  broadcastTrayState();
}

/** Update the today-spend bit shown in the tray tooltip. Called from
 *  index.ts after each task status change. */
export function setTodaySpend(usd: number): void {
  todaySpendUsd = Math.max(0, usd);
  rebuildToolTip();
  broadcastTrayState();
}

export function setAwaitingRepliesCount(n: number): void {
  awaitingReplies = Math.max(0, n);
  if (!tray) return;
  tray.setImage(buildIcon(runningTasks > 0 || awaitingReplies > 0));
  rebuildToolTip();
  rebuildMenu();
  broadcastTrayState();
}

/**
 * Number of reduced-to-chip conversations. Pushed from the renderer
 * via IPC so the tray tooltip surfaces "💬 N reduced" when the user
 * has things waiting in the chip strip but Jarvis isn't focused.
 */
export function setReducedConversationsCount(n: number): void {
  reducedConversations = Math.max(0, n);
  rebuildToolTip();
  broadcastTrayState();
}

/**
 * Replace the list of pinned conversations surfaced in the tray
 * menu. Pushed from the renderer's conversation-store whenever the
 * pin set changes. The list is small so we always replace it
 * wholesale rather than diff.
 */
export function setPinnedConversations(
  entries: PinnedConversationEntry[],
): void {
  pinnedConversations = entries;
  rebuildTitle();
  rebuildToolTip();
  rebuildMenu();
  broadcastTrayState();
}

export function getRunningTasksCount(): number {
  return runningTasks;
}
