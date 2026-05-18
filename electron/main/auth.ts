import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

import {
  DEFAULT_INBOX_PREFS,
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_WORKING_HOURS_PREFS,
  type AuthMode,
  type InboxPrefs,
  type ModuleSettingsValues,
  type NotificationPrefs,
  type WorkingHoursPrefs,
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
  /** AFK mode — when true, more notifications are mirrored to phone
   *  (via the Telegram module) so the user can act on them from afar.
   *  Cross-cutting state, not module-scoped. */
  afkMode?: boolean;
  /** Global pause. When true, routines + scheduled-action reminders
   *  don't fire — anything that would auto-spawn a Claude turn skips
   *  until the user resumes. User-initiated palette/voice/Telegram
   *  dispatches still work; pause is about *unattended* spend. */
  paused?: boolean;
  /** Working-hours window the user expects to be at their desk.
   *  Drives the `{businessHours}` placeholder substitution in
   *  workflow cron expressions — one setting controls every
   *  inbox feed's schedule. See loadWorkingHours/saveWorkingHours. */
  workingHours?: {
    startHour?: number;
    endHour?: number;
    daysOfWeek?: string;
  };
  /** Cost guardrails — single-task and daily totals. When unset, the
   *  defaults below apply. Set 0 or negative to disable a guardrail. */
  costPrefs?: {
    perTaskUsd?: number;
    dailyUsd?: number;
    /** When true, crossing the daily-budget threshold flips the global
     *  pause flag automatically. The user can resume manually. */
    autoPauseOnDaily?: boolean;
  };
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
    // typeof undefined → fall back to default. typeof boolean → carry.
    showMeetingStrip:
      typeof stored.showMeetingStrip === 'boolean'
        ? stored.showMeetingStrip
        : DEFAULT_INBOX_PREFS.showMeetingStrip,
    showAwaitingStrip:
      typeof stored.showAwaitingStrip === 'boolean'
        ? stored.showAwaitingStrip
        : DEFAULT_INBOX_PREFS.showAwaitingStrip,
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

export function loadAfkMode(): boolean {
  return readConfig().afkMode === true;
}

export function saveAfkMode(value: boolean): void {
  writeConfig({ ...readConfig(), afkMode: value });
}

export function loadPaused(): boolean {
  return readConfig().paused === true;
}

export function savePaused(value: boolean): void {
  writeConfig({ ...readConfig(), paused: value });
}

export function loadWorkingHours(): WorkingHoursPrefs {
  const cfg = readConfig() as { workingHours?: Partial<WorkingHoursPrefs> };
  const wh = cfg.workingHours ?? {};
  return {
    startHour:
      typeof wh.startHour === 'number' &&
      wh.startHour >= 0 &&
      wh.startHour <= 23
        ? wh.startHour
        : DEFAULT_WORKING_HOURS_PREFS.startHour,
    endHour:
      typeof wh.endHour === 'number' && wh.endHour >= 0 && wh.endHour <= 23
        ? wh.endHour
        : DEFAULT_WORKING_HOURS_PREFS.endHour,
    daysOfWeek:
      typeof wh.daysOfWeek === 'string' && wh.daysOfWeek.trim()
        ? wh.daysOfWeek.trim()
        : DEFAULT_WORKING_HOURS_PREFS.daysOfWeek,
  };
}

export function saveWorkingHours(value: WorkingHoursPrefs): void {
  // Normalize before persisting — caller may pass invalid hours.
  const safe: WorkingHoursPrefs = {
    startHour: clampHour(value.startHour, DEFAULT_WORKING_HOURS_PREFS.startHour),
    endHour: clampHour(value.endHour, DEFAULT_WORKING_HOURS_PREFS.endHour),
    daysOfWeek:
      typeof value.daysOfWeek === 'string' && value.daysOfWeek.trim()
        ? value.daysOfWeek.trim()
        : DEFAULT_WORKING_HOURS_PREFS.daysOfWeek,
  };
  writeConfig({ ...readConfig(), workingHours: safe });
}

function clampHour(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0 && v <= 23 ? Math.floor(v) : fallback;
}

export interface CostPrefs {
  /** Warn once when a single task crosses this USD threshold. 0 disables. */
  perTaskUsd: number;
  /** Warn when today's total spend crosses this USD threshold. 0 disables. */
  dailyUsd: number;
  /** When true, the daily-budget cross also flips the global pause flag. */
  autoPauseOnDaily: boolean;
}

export const DEFAULT_COST_PREFS: CostPrefs = {
  perTaskUsd: 0.5,
  dailyUsd: 5,
  autoPauseOnDaily: false,
};

export function loadCostPrefs(): CostPrefs {
  const stored = readConfig().costPrefs ?? {};
  const perTaskUsd =
    typeof stored.perTaskUsd === 'number' && Number.isFinite(stored.perTaskUsd)
      ? stored.perTaskUsd
      : DEFAULT_COST_PREFS.perTaskUsd;
  const dailyUsd =
    typeof stored.dailyUsd === 'number' && Number.isFinite(stored.dailyUsd)
      ? stored.dailyUsd
      : DEFAULT_COST_PREFS.dailyUsd;
  const autoPauseOnDaily =
    typeof stored.autoPauseOnDaily === 'boolean'
      ? stored.autoPauseOnDaily
      : DEFAULT_COST_PREFS.autoPauseOnDaily;
  return { perTaskUsd, dailyUsd, autoPauseOnDaily };
}

export function saveCostPrefs(prefs: CostPrefs): void {
  writeConfig({ ...readConfig(), costPrefs: prefs });
}
