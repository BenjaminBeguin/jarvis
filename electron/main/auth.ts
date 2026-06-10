import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

import {
  DEFAULT_INBOX_PREFS,
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_WORKING_HOURS_PREFS,
  type AppMode,
  type AuthMode,
  type InboxPrefs,
  type ModuleSettingsValues,
  type NotificationPrefs,
  type WorkingHoursPrefs,
} from '@shared/types';

import {
  asSpeedBias,
  DEFAULT_SPEED_BIAS,
  type SpeedBias,
} from './model-tiers.js';

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
  /** Legacy global tri-state operating mode. Phase 2 of workspaces
   *  migrated this to `appModesByWorkspace` (one slot per workspace
   *  id); on read, this value lands in the active workspace's slot
   *  and stays here as a fallback for surfaces that still read the
   *  legacy field. Drop only once every read site goes through
   *  loadAppMode. */
  appMode?: AppMode;
  /** Per-workspace operating mode. Keyed by workspace id. Lets the
   *  user run autopilot in "Work" while staying manual in "Personal."
   *  Missing entries fall back to legacy `appMode` then to
   *  DEFAULT_APP_MODE; the loader writes resolved values back here
   *  on first read so the field self-populates over time. */
  appModesByWorkspace?: Record<string, AppMode>;
  /** Legacy. Migrated to `appMode` on load and dropped on next write. */
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
  /** Per-workspace working hours. Lets the user set 9–5 weekdays for
   *  "Work" and free-form / blank for "Personal". Resolution falls
   *  through to the legacy global `workingHours` and finally
   *  DEFAULT_WORKING_HOURS_PREFS. */
  workingHoursByWorkspace?: Record<
    string,
    { startHour?: number; endHour?: number; daysOfWeek?: string }
  >;
  /** Cost guardrails — single-task and daily totals. When unset, the
   *  defaults below apply. Set 0 or negative to disable a guardrail. */
  costPrefs?: {
    perTaskUsd?: number;
    dailyUsd?: number;
    /** When true, crossing the daily-budget threshold flips the global
     *  pause flag automatically. The user can resume manually. */
    autoPauseOnDaily?: boolean;
  };
  /** Global speed bias for the tier-routing system. `auto` (default)
   *  respects each skill's declared tier; `prefer-fast` shifts every
   *  skill down a tier; `force-<tier>` clamps everything. See
   *  electron/main/model-tiers.ts. */
  speedBias?: string;
  /** Global default for "read each completed reply aloud". When
   *  true, every task launched from the Mac (palette free-text,
   *  conversation composer, voice orb, /ask) gets speakReply:true
   *  unless the caller explicitly overrides. The conversation
   *  composer's per-conversation toggle starts from this default
   *  and the user can flip it for any single conversation. */
  voiceAlwaysSpeak?: boolean;
  /** Currently-selected workspace id. Null / missing = the
   *  WorkspaceStore's default ("personal" by default). Persisted
   *  here so the user's last choice survives an app restart. */
  activeWorkspaceId?: string;
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

/**
 * Tiny in-memory cache so the dozen `load*` helpers don't each
 * re-read + re-parse config.json on every task launch. 500 ms TTL
 * is shorter than any human-perceivable mutation gap but covers
 * the burst of load calls inside a single launch path
 * (loadSpeedBias + loadAppMode + loadAfkMode + …). Writes
 * invalidate the cache so freshly-saved values are reflected
 * immediately to other readers in the same process.
 */
const CONFIG_CACHE_TTL_MS = 500;
let cachedConfig: { value: PersistedConfig; ts: number } | null = null;

function readConfig(): PersistedConfig {
  if (cachedConfig && Date.now() - cachedConfig.ts < CONFIG_CACHE_TTL_MS) {
    return cachedConfig.value;
  }
  if (!existsSync(CONFIG_PATH)) {
    cachedConfig = { value: {}, ts: Date.now() };
    return cachedConfig.value;
  }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    cachedConfig = { value: parsed, ts: Date.now() };
    return parsed;
  } catch {
    cachedConfig = { value: {}, ts: Date.now() };
    return cachedConfig.value;
  }
}

function writeConfig(cfg: PersistedConfig): void {
  mkdirSync(join(homedir(), '.jarvis'), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  // Invalidate so subsequent reads in this process see the write
  // immediately — saves a stale-by-up-to-500ms window if the user
  // toggles a setting then immediately fires a task.
  cachedConfig = { value: cfg, ts: Date.now() };
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

/**
 * Currently-selected workspace id. Null means "no explicit selection" —
 * the WorkspaceStore's default workspace is the implicit answer. We
 * keep this distinct from "default workspace" so the user can flip
 * back and forth across sessions without us clobbering their last
 * choice on every load.
 */
export function loadActiveWorkspaceId(): string | null {
  const v = readConfig().activeWorkspaceId;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Default-workspace-id resolver, set by the bootstrap once the
 * WorkspaceStore exists. `loadAppMode` / `loadWorkingHours` and their
 * setters use this to give the **default workspace its own dedicated
 * slot** when no explicit `activeWorkspaceId` is persisted. Without
 * this, reads/writes for the default workspace fall through to the
 * legacy global field — which then also acts as the fallback for
 * every other workspace whose slot is empty, making modes appear
 * shared across workspaces.
 *
 * Resolver only — auth.ts stays decoupled from WorkspaceStore by
 * accepting a function instead of importing the store.
 */
let resolveDefaultWorkspaceId: (() => string | null) | null = null;

export function setDefaultWorkspaceResolver(
  fn: () => string | null,
): void {
  resolveDefaultWorkspaceId = fn;
}

/**
 * Resolve the workspace id for keyed-by-workspace settings. Explicit
 * `id` wins; otherwise read the persisted `activeWorkspaceId`;
 * otherwise ask the default-workspace resolver. Returns null only
 * when the resolver isn't wired yet (very early boot).
 */
function resolveWorkspaceId(id: string | null): string | null {
  if (id !== null) return id;
  const stored = loadActiveWorkspaceId();
  if (stored) return stored;
  return resolveDefaultWorkspaceId?.() ?? null;
}

export function saveActiveWorkspaceId(id: string | null): void {
  const cfg = readConfig();
  const next = { ...cfg };
  if (id) {
    next.activeWorkspaceId = id;
  } else {
    delete (next as { activeWorkspaceId?: string }).activeWorkspaceId;
  }
  writeConfig(next);
}

/**
 * Read the tri-state app mode for the active workspace (or, when an
 * id is passed, that workspace). Resolution order:
 *
 *   1. `appModesByWorkspace[id]` — per-workspace canonical slot
 *   2. legacy global `appMode`   — pre-Phase-2 single value
 *   3. legacy `paused: boolean`  — pre-Phase-1 boolean
 *   4. DEFAULT_APP_MODE          — 'running'
 *
 * `id` defaults to `loadActiveWorkspaceId()` so most callers don't
 * need to pass anything. Workspace-agnostic callsites that want the
 * legacy global (e.g. a background task at boot before any workspace
 * is active) can pass `null` to read just the legacy field.
 */
export function loadAppMode(id: string | null = null): AppMode {
  const cfg = readConfig();
  const resolvedId = resolveWorkspaceId(id);
  if (resolvedId) {
    const perWs = cfg.appModesByWorkspace?.[resolvedId];
    if (perWs === 'paused' || perWs === 'running' || perWs === 'autopilot') {
      return perWs;
    }
  }
  if (cfg.appMode === 'paused' || cfg.appMode === 'running' || cfg.appMode === 'autopilot') {
    return cfg.appMode;
  }
  // Legacy migration path.
  return cfg.paused === true ? 'paused' : 'running';
}

/**
 * Write the active workspace's app mode (or, when `id` is passed,
 * that specific workspace's). Other workspaces are unaffected.
 * Also keeps the legacy global `appMode` field in sync with the
 * default workspace's slot so non-workspace-aware readers stay
 * truthful — a clean-up that can shrink once every reader is
 * migrated.
 */
export function saveAppMode(mode: AppMode, id: string | null = null): void {
  const cfg = readConfig();
  const resolvedId = resolveWorkspaceId(id);
  const next = { ...cfg };
  if (resolvedId) {
    const byWs = { ...(cfg.appModesByWorkspace ?? {}) };
    byWs[resolvedId] = mode;
    next.appModesByWorkspace = byWs;
  } else {
    // No workspace context — keep writing the legacy global.
    next.appMode = mode;
  }
  // One-shot strip of the legacy field once we've written the canonical
  // `appMode`. Idempotent — second save just sees no `paused`.
  delete (next as { paused?: boolean }).paused;
  writeConfig(next);
}

/**
 * Back-compat shim. Existing callsites in notifier / routines /
 * reminders read this. Now resolves through `appMode`.
 */
export function loadPaused(): boolean {
  return loadAppMode() === 'paused';
}

/**
 * Back-compat shim. Maps boolean to the new tri-state: `true →
 * 'paused'`, `false → 'running'`. Anything that wants explicit
 * autopilot should call `saveAppMode` directly.
 */
export function savePaused(value: boolean): void {
  saveAppMode(value ? 'paused' : 'running');
}

/**
 * "Always read replies aloud" global preference. Default false —
 * voice-loop and any explicit `speakReply:true` in SessionConfig
 * still work without it. When true, every Mac-initiated task gets
 * its completed reply spoken via macOS TTS unless the caller
 * explicitly opts out.
 */
export function loadVoiceAlwaysSpeak(): boolean {
  const cfg = readConfig();
  return cfg.voiceAlwaysSpeak === true;
}

export function saveVoiceAlwaysSpeak(value: boolean): void {
  const cfg = readConfig();
  writeConfig({ ...cfg, voiceAlwaysSpeak: value === true });
}

/**
 * Global speed-bias preference for the tier-routing system. Read
 * by TaskRunner when resolving a skill's tier to a concrete model.
 * Validation lives in `model-tiers.ts:asSpeedBias` — anything
 * unrecognised collapses to the default.
 */
export function loadSpeedBias(): SpeedBias {
  const cfg = readConfig();
  return asSpeedBias(cfg.speedBias ?? DEFAULT_SPEED_BIAS);
}

export function saveSpeedBias(value: SpeedBias): void {
  const cfg = readConfig();
  writeConfig({ ...cfg, speedBias: value });
}

/**
 * Working-hours preferences for the active workspace (or, when an
 * `id` is passed, that workspace specifically). Resolution:
 *
 *   1. `workingHoursByWorkspace[id]` — per-workspace canonical slot
 *   2. legacy global `workingHours`  — pre-Phase-2 single value
 *   3. DEFAULT_WORKING_HOURS_PREFS
 *
 * Each FIELD falls through independently so a workspace can override
 * just `daysOfWeek` (e.g. "Side Project = weekends") while inheriting
 * hours from the legacy global.
 */
export function loadWorkingHours(
  id: string | null = null,
): WorkingHoursPrefs {
  const cfg = readConfig();
  const resolvedId = resolveWorkspaceId(id);
  const perWs = resolvedId
    ? cfg.workingHoursByWorkspace?.[resolvedId]
    : undefined;
  const legacy = cfg.workingHours;
  const pick = <K extends keyof WorkingHoursPrefs>(
    key: K,
    validate: (v: unknown) => v is WorkingHoursPrefs[K],
  ): WorkingHoursPrefs[K] => {
    const fromWs = perWs?.[key];
    if (validate(fromWs)) return fromWs;
    const fromLegacy = legacy?.[key];
    if (validate(fromLegacy)) return fromLegacy;
    return DEFAULT_WORKING_HOURS_PREFS[key];
  };
  const validHour = (v: unknown): v is number =>
    typeof v === 'number' && v >= 0 && v <= 23;
  const validDays = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length > 0;
  return {
    startHour: pick('startHour', validHour),
    endHour: pick('endHour', validHour),
    daysOfWeek: pick('daysOfWeek', validDays),
  };
}

/**
 * Write working hours into the active workspace's slot (or a given
 * id's slot). Use `null` to write the legacy global field — useful
 * only for boot-time defaults or per-workspace-unaware callers.
 */
export function saveWorkingHours(
  value: WorkingHoursPrefs,
  id: string | null = null,
): void {
  // Normalize before persisting — caller may pass invalid hours.
  const safe: WorkingHoursPrefs = {
    startHour: clampHour(value.startHour, DEFAULT_WORKING_HOURS_PREFS.startHour),
    endHour: clampHour(value.endHour, DEFAULT_WORKING_HOURS_PREFS.endHour),
    daysOfWeek:
      typeof value.daysOfWeek === 'string' && value.daysOfWeek.trim()
        ? value.daysOfWeek.trim()
        : DEFAULT_WORKING_HOURS_PREFS.daysOfWeek,
  };
  const cfg = readConfig();
  const resolvedId = resolveWorkspaceId(id);
  if (resolvedId) {
    const byWs = { ...(cfg.workingHoursByWorkspace ?? {}) };
    byWs[resolvedId] = safe;
    writeConfig({ ...cfg, workingHoursByWorkspace: byWs });
  } else {
    writeConfig({ ...cfg, workingHours: safe });
  }
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
