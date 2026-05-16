import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

import {
  DEFAULT_INBOX_PREFS,
  DEFAULT_NOTIFICATION_PREFS,
  type AuthMode,
  type InboxPrefs,
  type ModuleSettingsValues,
  type NotificationPrefs,
} from '@shared/types';

interface PersistedConfig {
  authMode?: AuthMode;
  disabledModules?: string[];
  notificationPrefs?: Partial<NotificationPrefs>;
  inboxPrefs?: Partial<InboxPrefs>;
  /** Per-module user settings — keyed by module id. The schema lives
   *  in the module definition; this just stores whichever values the
   *  user explicitly set. Unset keys fall back to the schema default. */
  moduleSettings?: Record<string, ModuleSettingsValues>;
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

export function loadInboxPrefs(): InboxPrefs {
  const cfg = readConfig();
  const stored = cfg.inboxPrefs ?? {};
  const rawHours = stored.calendarWindowHours;
  const calendarWindowHours =
    typeof rawHours === 'number' && Number.isFinite(rawHours) && rawHours > 0
      ? Math.min(rawHours, 24 * 31) // cap at one month so a typo can't break things
      : DEFAULT_INBOX_PREFS.calendarWindowHours;
  return {
    disabledSources: Array.isArray(stored.disabledSources)
      ? stored.disabledSources.filter((x): x is string => typeof x === 'string')
      : DEFAULT_INBOX_PREFS.disabledSources,
    calendarWindowHours,
  };
}

export function saveInboxPrefs(prefs: InboxPrefs): void {
  writeConfig({ ...readConfig(), inboxPrefs: prefs });
}

/**
 * Load only the values the user has explicitly set for a module. The
 * caller merges with the schema defaults. Returns `{}` when the module
 * has never had a value persisted.
 */
export function loadModuleSettings(moduleId: string): ModuleSettingsValues {
  const cfg = readConfig();
  const stored = cfg.moduleSettings?.[moduleId];
  if (!stored || typeof stored !== 'object') return {};
  // Filter out non-primitive values that might have snuck in via a
  // hand-edit. Keeps the type contract clean.
  const out: ModuleSettingsValues = {};
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

export function saveModuleSettings(
  moduleId: string,
  values: ModuleSettingsValues,
): void {
  const cfg = readConfig();
  const next = { ...(cfg.moduleSettings ?? {}) };
  next[moduleId] = values;
  writeConfig({ ...cfg, moduleSettings: next });
}
