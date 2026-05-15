import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

import {
  DEFAULT_NOTIFICATION_PREFS,
  type AuthMode,
  type NotificationPrefs,
} from '@shared/types';

interface PersistedConfig {
  authMode?: AuthMode;
  disabledModules?: string[];
  notificationPrefs?: Partial<NotificationPrefs>;
}

const CONFIG_PATH = join(homedir(), '.jarvis', 'config.json');

// Where Claude Code typically installs the `claude` binary; we probe these
// before falling back to `which` so a missing PATH entry in Electron's env
// doesn't make us think the CLI is absent.
const CANDIDATE_PATHS = [
  join(homedir(), '.local', 'bin', 'claude'),
  join(homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

export function detectClaudeBinary(): string | null {
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: ask the user's shell.
  try {
    const out = execSync('command -v claude', {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [
          process.env['PATH'] ?? '',
          join(homedir(), '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ].join(delimiter),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (out && existsSync(out)) return out;
  } catch {
    // not found
  }
  return null;
}

function readConfig(): PersistedConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg: PersistedConfig): void {
  mkdirSync(join(homedir(), '.jarvis'), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

export function loadAuthMode(): AuthMode | null {
  const cfg = readConfig();
  if (cfg.authMode === 'subscription' || cfg.authMode === 'api-key') {
    return cfg.authMode;
  }
  return null;
}

export function saveAuthMode(mode: AuthMode): void {
  writeConfig({ ...readConfig(), authMode: mode });
}

export function clearAuthMode(): void {
  const cfg = readConfig();
  delete cfg.authMode;
  writeConfig(cfg);
}

export function loadDisabledModules(): string[] {
  const cfg = readConfig();
  return Array.isArray(cfg.disabledModules) ? cfg.disabledModules : [];
}

export function saveDisabledModules(ids: string[]): void {
  writeConfig({ ...readConfig(), disabledModules: ids });
}

export function loadNotificationPrefs(): NotificationPrefs {
  const cfg = readConfig();
  const stored = cfg.notificationPrefs ?? {};
  // Validate stored values — drop typos / outdated enums so a corrupted
  // config falls back to the default rather than yielding undefined.
  const onAsk: NotificationPrefs['onAsk'] =
    stored.onAsk === 'silent' || stored.onAsk === 'toast' || stored.onAsk === 'open'
      ? stored.onAsk
      : DEFAULT_NOTIFICATION_PREFS.onAsk;
  const onLaunch: NotificationPrefs['onLaunch'] =
    stored.onLaunch === 'silent' || stored.onLaunch === 'toast'
      ? stored.onLaunch
      : DEFAULT_NOTIFICATION_PREFS.onLaunch;
  return { onAsk, onLaunch };
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  writeConfig({ ...readConfig(), notificationPrefs: prefs });
}
