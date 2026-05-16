import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const preloadPath = join(__dirname, '../preload/index.cjs');
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererProdEntry = join(__dirname, '../renderer/index.html');

function loadRoute(win: BrowserWindow, route: string): void {
  if (rendererDevUrl) {
    void win.loadURL(`${rendererDevUrl}#${route}`);
  } else {
    void win.loadFile(rendererProdEntry, { hash: route });
  }
}

let observatoryWindow: BrowserWindow | null = null;
let paletteWindow: BrowserWindow | null = null;
let answerHudWindow: BrowserWindow | null = null;

export function openObservatory(): BrowserWindow {
  if (observatoryWindow && !observatoryWindow.isDestroyed()) {
    observatoryWindow.show();
    observatoryWindow.focus();
    return observatoryWindow;
  }
  observatoryWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d12',
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  observatoryWindow.on('ready-to-show', () => observatoryWindow?.show());
  observatoryWindow.on('closed', () => {
    observatoryWindow = null;
  });
  loadRoute(observatoryWindow, '/observatory');
  return observatoryWindow;
}

export function openPalette(): BrowserWindow {
  if (paletteWindow && !paletteWindow.isDestroyed()) {
    if (paletteWindow.isVisible()) {
      paletteWindow.hide();
    } else {
      paletteWindow.show();
      paletteWindow.focus();
    }
    return paletteWindow;
  }
  const display = screen.getPrimaryDisplay();
  const width = 680;
  // Start tall enough to fit the input bar comfortably; the renderer calls
  // resizePalette() to grow when the picker opens and shrink when it closes,
  // so the visible footprint matches the content exactly.
  const initialHeight = 110;
  paletteWindow = new BrowserWindow({
    width,
    height: initialHeight,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + display.workArea.height * 0.22),
    frame: false,
    transparent: true,
    // No vibrancy: the empty area below the input was rendering as a giant
    // frosted-white sheet over the desktop. Going fully transparent + dark
    // glass on the input itself looks like a floating console panel
    // instead of a window.
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  paletteWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  paletteWindow.on('blur', () => paletteWindow?.hide());
  paletteWindow.on('ready-to-show', () => {
    paletteWindow?.show();
    paletteWindow?.focus();
  });
  paletteWindow.on('closed', () => {
    paletteWindow = null;
  });
  loadRoute(paletteWindow, '/palette');
  return paletteWindow;
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Send an IPC message to a window — deferred until the renderer has
 * actually finished loading. Most "open window then talk to it"
 * callers need this; firing immediately into a still-loading webContents
 * silently drops the message.
 */
export function sendWhenReady(
  win: BrowserWindow,
  channel: string,
  payload: unknown,
): void {
  if (win.isDestroyed()) return;
  const send = () => win.webContents.send(channel, payload);
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

export function hidePalette(): void {
  if (paletteWindow && !paletteWindow.isDestroyed()) paletteWindow.hide();
}

/**
 * Resize the palette window's height to fit its current content. Keeps the
 * top edge anchored so the input bar doesn't jump as the picker expands.
 */
export function resizePalette(targetHeight: number): void {
  if (!paletteWindow || paletteWindow.isDestroyed()) return;
  const clamped = Math.max(80, Math.min(720, Math.round(targetHeight)));
  const [w] = paletteWindow.getSize();
  paletteWindow.setSize(w, clamped, false);
}

const HUD_WIDTH = 380;
const HUD_INITIAL_HEIGHT = 140;
const HUD_MARGIN = 16;

/**
 * Open (or focus) the always-on-top "Answer HUD" docked to the top-right
 * of the primary display. The HUD owns its own state and renders the stack
 * of unacknowledged answers; this just makes sure the window exists and
 * is visible.
 */
export function showAnswerHud(): BrowserWindow {
  if (answerHudWindow && !answerHudWindow.isDestroyed()) {
    if (!answerHudWindow.isVisible()) answerHudWindow.show();
    // Bring it to the front without stealing keyboard focus — the user is
    // probably still typing in the palette. focus() would steal; show()
    // alone is enough on top-most windows.
    answerHudWindow.moveTop();
    return answerHudWindow;
  }
  const display = screen.getPrimaryDisplay();
  const x = display.workArea.x + display.workArea.width - HUD_WIDTH - HUD_MARGIN;
  const y = display.workArea.y + HUD_MARGIN;
  answerHudWindow = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_INITIAL_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  answerHudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through by default: the window's transparent padding around the
  // card would otherwise block clicks to Cursor / Chrome / whatever is
  // underneath. `forward: true` keeps mouse-move events flowing so the
  // renderer can detect when the cursor enters a card and flip
  // interactivity back on via setAnswerHudInteractive.
  answerHudWindow.setIgnoreMouseEvents(true, { forward: true });
  answerHudWindow.on('ready-to-show', () => answerHudWindow?.show());
  answerHudWindow.on('closed', () => {
    answerHudWindow = null;
  });
  loadRoute(answerHudWindow, '/answer-hud');
  return answerHudWindow;
}

export function hideAnswerHud(): void {
  if (answerHudWindow && !answerHudWindow.isDestroyed()) answerHudWindow.hide();
}

/**
 * Toggle whether the HUD window captures clicks. False = click-through
 * (default, lets the user keep working in apps underneath). True = card is
 * hovered, the user wants to interact with the reply input / buttons.
 */
export function setAnswerHudInteractive(interactive: boolean): void {
  if (!answerHudWindow || answerHudWindow.isDestroyed()) return;
  if (interactive) {
    answerHudWindow.setIgnoreMouseEvents(false);
  } else {
    answerHudWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

/**
 * Resize the HUD's height to fit the card stack. Re-anchor the top-right
 * corner so it grows downward and stays glued to the right edge.
 */
export function resizeAnswerHud(targetHeight: number): void {
  if (!answerHudWindow || answerHudWindow.isDestroyed()) return;
  const clamped = Math.max(80, Math.min(900, Math.round(targetHeight)));
  const [w] = answerHudWindow.getSize();
  const display = screen.getPrimaryDisplay();
  const x = display.workArea.x + display.workArea.width - w - HUD_MARGIN;
  const y = display.workArea.y + HUD_MARGIN;
  answerHudWindow.setBounds({ x, y, width: w, height: clamped }, false);
}

export function getAnswerHudWindow(): BrowserWindow | null {
  return answerHudWindow && !answerHudWindow.isDestroyed() ? answerHudWindow : null;
}
