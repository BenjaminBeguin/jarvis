import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openObservatory, openPalette } from './windows.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let tray: Tray | null = null;
let runningTasks = 0;

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

export function initTray(): Tray {
  if (tray) return tray;
  tray = new Tray(buildIcon(false));
  tray.setToolTip('Jarvis');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Observatory', click: () => openObservatory() },
      { label: 'Open Palette  ⌘⇧J', click: () => openPalette() },
      { type: 'separator' },
      { role: 'quit' },
    ]),
  );
  tray.on('click', () => openObservatory());
  return tray;
}

export function setRunningTasksCount(n: number): void {
  runningTasks = Math.max(0, n);
  if (!tray) return;
  tray.setImage(buildIcon(runningTasks > 0));
  tray.setToolTip(
    runningTasks > 0 ? `Jarvis — ${runningTasks} running` : 'Jarvis',
  );
}

export function getRunningTasksCount(): number {
  return runningTasks;
}
