#!/usr/bin/env node
/**
 * build-icons — Generate macOS app + tray icon assets from the SVG sources.
 *
 *   sources:
 *     resources/icons/jarvis-app.svg         (1024×1024 squircle)
 *     resources/icons/jarvis-tray.svg        (32×32 template)
 *     resources/icons/jarvis-tray-active.svg (32×32 template)
 *
 *   outputs:
 *     resources/icons/icon.icns              (macOS app icon — picked up
 *                                             by electron-builder via
 *                                             `directories.buildResources`)
 *     resources/icons/icon.png               (1024 PNG — Linux + dev
 *                                             BrowserWindow fallback)
 *     resources/icons/tray-idle.png          (16×16)
 *     resources/icons/tray-idle@2x.png       (32×32)
 *     resources/icons/tray-active.png        (16×16)
 *     resources/icons/tray-active@2x.png     (32×32)
 *
 * The .icns is built via the macOS-native `iconutil` so it always
 * matches Apple's expected layer set. On non-mac hosts we skip the
 * .icns step and warn — packaging happens on Mac only anyway.
 *
 * Run after editing any of the SVG sources:
 *   pnpm build:icons
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');
const icons = join(root, 'resources', 'icons');

const APP_SVG = join(icons, 'jarvis-app.svg');
const TRAY_SVG = join(icons, 'jarvis-tray.svg');
const TRAY_ACTIVE_SVG = join(icons, 'jarvis-tray-active.svg');

// Apple's required iconset layer table. Names are exact —
// `iconutil` parses them.
const ICONSET_LAYERS = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

async function renderSvg(svgPath, size, outPath) {
  const svg = readFileSync(svgPath);
  await sharp(svg, { density: 384 })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function buildAppIcon() {
  // 1) Single 1024 PNG (Linux + dev fallback).
  const png = join(icons, 'icon.png');
  await renderSvg(APP_SVG, 1024, png);
  console.log(`✓ ${png}`);

  // 2) macOS .icns via iconutil.
  if (process.platform !== 'darwin') {
    console.warn('⚠ skipping .icns (non-mac host) — Linux/dev PNG is enough');
    return;
  }
  const iconset = mkdtempSync(join(tmpdir(), 'jarvis-iconset-'));
  const iconsetDir = `${iconset}/icon.iconset`;
  mkdirSync(iconsetDir, { recursive: true });
  for (const { name, size } of ICONSET_LAYERS) {
    await renderSvg(APP_SVG, size, join(iconsetDir, name));
  }
  const icns = join(icons, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icns]);
  rmSync(iconset, { recursive: true, force: true });
  console.log(`✓ ${icns}`);
}

async function buildTrayPair(svgPath, baseName) {
  // Template images: macOS recolours from the alpha channel. Source
  // SVG already uses pure black; sharp keeps the alpha.
  await renderSvg(svgPath, 16, join(icons, `${baseName}.png`));
  await renderSvg(svgPath, 32, join(icons, `${baseName}@2x.png`));
  console.log(`✓ ${baseName}.png + ${baseName}@2x.png`);
}

async function main() {
  await buildAppIcon();
  await buildTrayPair(TRAY_SVG, 'tray-idle');
  await buildTrayPair(TRAY_ACTIVE_SVG, 'tray-active');
  // Also drop the 512 PNG that the renderer uses (currently src/renderer/public/icons/jarvis.svg).
  // Keep it as a PNG fallback for surfaces that don't accept SVG.
  const renderer = join(root, 'src', 'renderer', 'public', 'icons', 'jarvis.png');
  await renderSvg(APP_SVG, 512, renderer);
  console.log(`✓ ${renderer}`);
}

main().catch((err) => {
  console.error('build-icons failed:', err);
  process.exit(1);
});
