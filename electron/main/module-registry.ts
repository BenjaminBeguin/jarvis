import { EventEmitter } from 'node:events';

import type {
  DispatchIntentResult,
  ModuleSettingsValues,
  ModuleSummary,
  PaletteIntentSummary,
} from '@shared/types';

import {
  loadDisabledModules,
  loadModuleSettings,
  saveDisabledModules,
  saveModuleSettings,
} from './auth.js';
import type { Module, ModuleContext, PaletteIntent } from './modules/types.js';

interface RegistryEntry {
  module: Module;
  intentsById: Map<string, PaletteIntent>;
  enabled: boolean;
  hasPage: boolean;
}

export class ModuleRegistry extends EventEmitter {
  private readonly modules = new Map<string, RegistryEntry>();
  private ctx: ModuleContext | null = null;
  // Lazy: defer reading the disabled-modules list until first use so the
  // workspace resolver in auth.ts has a chance to be wired up (the
  // registry is constructed at module-import time, but the resolver
  // attaches after `workspaces.init()` runs).
  private disabledIds: Set<string> | null = null;
  // Renderer-side pages exist for these module ids. We mirror that here so
  // the renderer can render a 'View' affordance without an extra lookup.
  private static readonly PAGED_MODULES = new Set([
    'quick-note',
    'meeting-recorder',
    'calendar',
  ]);

  setContext(ctx: ModuleContext): void {
    this.ctx = ctx;
  }

  private getDisabled(): Set<string> {
    if (!this.disabledIds) {
      this.disabledIds = new Set(loadDisabledModules());
    }
    return this.disabledIds;
  }

  async register(module: Module): Promise<void> {
    if (!this.ctx) throw new Error('ModuleRegistry: setContext() before register()');
    if (this.modules.has(module.id)) {
      throw new Error(`Module already registered: ${module.id}`);
    }
    const intentsById = new Map<string, PaletteIntent>();
    for (const intent of module.intents ?? []) {
      if (!intent.prefix.startsWith('/') || /\s/.test(intent.prefix)) {
        throw new Error(
          `Module ${module.id}: intent prefix must start with "/" and have no spaces — got "${intent.prefix}"`,
        );
      }
      intentsById.set(intent.id, intent);
    }
    const enabled = !this.getDisabled().has(module.id);
    this.modules.set(module.id, {
      module,
      intentsById,
      enabled,
      hasPage: ModuleRegistry.PAGED_MODULES.has(module.id),
    });
    if (enabled) await module.onLoad?.(this.ctx);
    this.emit('changed', this.list());
  }

  async unloadAll(): Promise<void> {
    for (const entry of this.modules.values()) {
      if (!entry.enabled) continue;
      try {
        await entry.module.onUnload?.();
      } catch (err) {
        console.warn(`module ${entry.module.id} onUnload threw:`, err);
      }
    }
    this.modules.clear();
    this.emit('changed', this.list());
  }

  /**
   * Unload + reload an enabled module. Useful when an out-of-band config
   * change (e.g. a secret written to Keychain via a dedicated IPC) should
   * re-trigger onLoad so the module picks up the new value. No-op if the
   * module is disabled — re-enabling it is the user's choice.
   */
  async reload(moduleId: string): Promise<void> {
    if (!this.ctx) throw new Error('ModuleRegistry: not initialized');
    const entry = this.modules.get(moduleId);
    if (!entry) throw new Error(`Unknown module: ${moduleId}`);
    if (!entry.enabled) return;
    try {
      await entry.module.onUnload?.();
    } catch (err) {
      console.warn(`module ${moduleId} onUnload threw during reload:`, err);
    }
    try {
      await entry.module.onLoad?.(this.ctx);
    } catch (err) {
      throw new Error(
        `module ${moduleId} failed to reload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.emit('changed', this.list());
  }

  async setEnabled(moduleId: string, enabled: boolean): Promise<void> {
    if (!this.ctx) throw new Error('ModuleRegistry: not initialized');
    const entry = this.modules.get(moduleId);
    if (!entry) throw new Error(`Unknown module: ${moduleId}`);
    if (entry.enabled === enabled) return;
    const disabled = this.getDisabled();
    if (enabled) {
      try {
        await entry.module.onLoad?.(this.ctx);
      } catch (err) {
        throw new Error(
          `module ${moduleId} failed to load: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      disabled.delete(moduleId);
    } else {
      try {
        await entry.module.onUnload?.();
      } catch (err) {
        console.warn(`module ${moduleId} onUnload threw:`, err);
      }
      disabled.add(moduleId);
    }
    entry.enabled = enabled;
    saveDisabledModules([...disabled]);
    this.emit('changed', this.list());
  }

  /**
   * Re-evaluate every registered module against the active workspace's
   * disabled list. Called on workspace switch:
   *
   *   - module enabled here but disabled in the new workspace → onUnload
   *   - module disabled here but enabled in the new workspace   → onLoad
   *
   * The whole point of per-workspace module enablement is that side
   * effects (Telegram bot connection, chokidar watchers, cron timers)
   * actually go away — so we go through the real onLoad / onUnload
   * lifecycle rather than just masking visibility. Lifecycle errors
   * don't abort the transition; we log + continue so a single bad
   * module can't strand the user with half the new workspace's
   * modules loaded.
   */
  async applyWorkspaceTransition(): Promise<void> {
    if (!this.ctx) return;
    const nextDisabled = new Set(loadDisabledModules());
    for (const [moduleId, entry] of this.modules) {
      const shouldBeEnabled = !nextDisabled.has(moduleId);
      if (shouldBeEnabled === entry.enabled) continue;
      try {
        if (shouldBeEnabled) {
          await entry.module.onLoad?.(this.ctx);
        } else {
          await entry.module.onUnload?.();
        }
      } catch (err) {
        console.warn(
          `module ${moduleId} workspace-transition error:`,
          err,
        );
      }
      entry.enabled = shouldBeEnabled;
    }
    this.disabledIds = nextDisabled;
    this.emit('changed', this.list());
  }

  list(): ModuleSummary[] {
    return [...this.modules.values()].map(({ module, intentsById, enabled, hasPage }) => ({
      id: module.id,
      name: module.name,
      description: module.description,
      version: module.version,
      enabled,
      hasPage,
      // Hide intents while disabled — the palette shouldn't surface routes
      // we wouldn't actually run.
      intents: enabled
        ? [...intentsById.values()].map((i) => toIntentSummary(module.id, i))
        : [],
      settings: module.settings,
      settingsValues: module.settings
        ? mergeWithDefaults(module.settings, loadModuleSettings(module.id))
        : undefined,
      memory: module.memory,
    }));
  }

  /**
   * Read the currently-effective settings for a module (defaults merged
   * with persisted overrides). Returns null when the module has no
   * settings schema. Callers in main use this to drive their own
   * behaviour (e.g. a routine handler reading its cadence). The
   * renderer reads via the same merge in `list()` above so both stay
   * in sync.
   */
  readSettings(moduleId: string): ModuleSettingsValues | null {
    const entry = this.modules.get(moduleId);
    if (!entry || !entry.module.settings) return null;
    return mergeWithDefaults(
      entry.module.settings,
      loadModuleSettings(moduleId),
    );
  }

  /**
   * Persist a new value bag for a module. Renderer calls this from the
   * settings panel; main callers (rarely needed) can use it to seed
   * defaults at boot. Emits 'changed' so the renderer's listModules
   * subscribers see fresh settingsValues.
   */
  writeSettings(moduleId: string, values: ModuleSettingsValues): boolean {
    const entry = this.modules.get(moduleId);
    if (!entry || !entry.module.settings) return false;
    // Validate: drop keys not in the schema, coerce types where we can.
    const clean: ModuleSettingsValues = {};
    for (const field of entry.module.settings.fields) {
      const v = values[field.key];
      if (v === undefined) continue;
      if (typeof v === typeof field.default) clean[field.key] = v;
    }
    saveModuleSettings(moduleId, clean);
    this.emit('changed', this.list());
    return true;
  }

  listIntents(): PaletteIntentSummary[] {
    const out: PaletteIntentSummary[] = [];
    for (const { module, intentsById, enabled } of this.modules.values()) {
      if (!enabled) continue;
      for (const intent of intentsById.values()) {
        out.push(toIntentSummary(module.id, intent));
      }
    }
    return out;
  }

  /**
   * Find the intent whose verbal trigger best matches the leading words
   * of `prompt`. Returns null if nothing matches. "Best" = longest trigger
   * length (so "record the meeting" beats "record" if both are registered).
   * Match is case-insensitive and requires the trigger to start the prompt
   * (followed by end-of-string or whitespace) — prevents loose substring
   * matches on long sentences.
   */
  matchVerbal(
    prompt: string,
  ): { moduleId: string; intentId: string; rest: string } | null {
    const lower = prompt.toLowerCase().trim();
    if (!lower) return null;
    let best:
      | { moduleId: string; intentId: string; rest: string; len: number }
      | null = null;
    for (const { module, intentsById, enabled } of this.modules.values()) {
      if (!enabled) continue;
      for (const intent of intentsById.values()) {
        for (const triggerRaw of intent.verbalTriggers ?? []) {
          const trigger = triggerRaw.toLowerCase().trim();
          if (!trigger) continue;
          if (lower === trigger || lower.startsWith(trigger + ' ')) {
            if (!best || trigger.length > best.len) {
              const rest = prompt.slice(trigger.length).trim();
              best = {
                moduleId: module.id,
                intentId: intent.id,
                rest: stripLeadingConnectors(rest),
                len: trigger.length,
              };
            }
          }
        }
      }
    }
    if (best) {
      return {
        moduleId: best.moduleId,
        intentId: best.intentId,
        rest: best.rest,
      };
    }
    // Fallback layer: regex patterns. Lets intents match phrasings
    // where the payload lives mid-sentence ("create a hivecore project"
    // → /new-project with input "hivecore"). First capture group is
    // the input. Patterns tried AFTER literal triggers so explicit
    // prefixes always win.
    for (const { module, intentsById, enabled } of this.modules.values()) {
      if (!enabled) continue;
      for (const intent of intentsById.values()) {
        for (const pattern of intent.verbalPatterns ?? []) {
          const m = prompt.match(pattern);
          if (m) {
            return {
              moduleId: module.id,
              intentId: intent.id,
              rest: (m[1] ?? '').trim(),
            };
          }
        }
      }
    }
    return null;
  }

  async dispatch(
    moduleId: string,
    intentId: string,
    input: string,
  ): Promise<DispatchIntentResult> {
    if (!this.ctx) throw new Error('ModuleRegistry: not initialized');
    const entry = this.modules.get(moduleId);
    if (!entry) return { ok: false, message: `Unknown module: ${moduleId}` };
    if (!entry.enabled) {
      return { ok: false, message: `Module disabled: ${moduleId}` };
    }
    const intent = entry.intentsById.get(intentId);
    if (!intent) {
      return { ok: false, message: `Unknown intent ${moduleId}.${intentId}` };
    }
    try {
      const returned = await intent.handler(input, this.ctx);
      const message = typeof returned === 'string' && returned ? returned : undefined;
      return { ok: true, message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}

/**
 * After stripping a trigger like 'record the meeting' from
 * 'record the meeting about Q3', the remainder is 'about Q3'.
 * Strip a small set of leading connectors so the handler sees just
 * the actual content ('Q3').
 */
function stripLeadingConnectors(s: string): string {
  return s
    .replace(/^(on|about|for|to|that|called|named|titled|with)\s+/i, '')
    .trim();
}

function toIntentSummary(
  moduleId: string,
  intent: PaletteIntent,
): PaletteIntentSummary {
  return {
    id: intent.id,
    moduleId,
    prefix: intent.prefix,
    label: intent.label,
    description: intent.description,
    placeholder: intent.placeholder,
  };
}

function mergeWithDefaults(
  spec: import('@shared/types').ModuleSettingsSpec,
  stored: ModuleSettingsValues,
): ModuleSettingsValues {
  const out: ModuleSettingsValues = {};
  for (const field of spec.fields) {
    out[field.key] = stored[field.key] !== undefined ? stored[field.key]! : field.default;
  }
  return out;
}
