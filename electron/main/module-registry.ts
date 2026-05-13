import { EventEmitter } from 'node:events';

import type {
  DispatchIntentResult,
  ModuleSummary,
  PaletteIntentSummary,
} from '@shared/types';

import { loadDisabledModules, saveDisabledModules } from './auth.js';
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
  private disabledIds = new Set<string>(loadDisabledModules());
  // Renderer-side pages exist for these module ids. We mirror that here so
  // the renderer can render a 'View' affordance without an extra lookup.
  private static readonly PAGED_MODULES = new Set([
    'quick-note',
    'meeting-recorder',
  ]);

  setContext(ctx: ModuleContext): void {
    this.ctx = ctx;
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
    const enabled = !this.disabledIds.has(module.id);
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

  async setEnabled(moduleId: string, enabled: boolean): Promise<void> {
    if (!this.ctx) throw new Error('ModuleRegistry: not initialized');
    const entry = this.modules.get(moduleId);
    if (!entry) throw new Error(`Unknown module: ${moduleId}`);
    if (entry.enabled === enabled) return;
    if (enabled) {
      try {
        await entry.module.onLoad?.(this.ctx);
      } catch (err) {
        throw new Error(
          `module ${moduleId} failed to load: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.disabledIds.delete(moduleId);
    } else {
      try {
        await entry.module.onUnload?.();
      } catch (err) {
        console.warn(`module ${moduleId} onUnload threw:`, err);
      }
      this.disabledIds.add(moduleId);
    }
    entry.enabled = enabled;
    saveDisabledModules([...this.disabledIds]);
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
    }));
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
