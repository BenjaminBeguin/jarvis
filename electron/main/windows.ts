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
  const height = 360;
  paletteWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + display.workArea.height * 0.22),
    frame: false,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
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

export function hidePalette(): void {
  if (paletteWindow && !paletteWindow.isDestroyed()) paletteWindow.hide();
}
