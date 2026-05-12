import { EventEmitter } from 'node:events';

import type {
  DispatchIntentResult,
  ModuleSummary,
  PaletteIntentSummary,
} from '@shared/types';

import type { Module, ModuleContext, PaletteIntent } from './modules/types.js';

interface RegistryEntry {
  module: Module;
  intentsById: Map<string, PaletteIntent>;
}

export class ModuleRegistry extends EventEmitter {
  private readonly modules = new Map<string, RegistryEntry>();
  private ctx: ModuleContext | null = null;

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
    this.modules.set(module.id, { module, intentsById });
    await module.onLoad?.(this.ctx);
    this.emit('changed', this.list());
  }

  async unloadAll(): Promise<void> {
    for (const entry of this.modules.values()) {
      try {
        await entry.module.onUnload?.();
      } catch (err) {
        console.warn(`module ${entry.module.id} onUnload threw:`, err);
      }
    }
    this.modules.clear();
    this.emit('changed', this.list());
  }

  list(): ModuleSummary[] {
    return [...this.modules.values()].map(({ module, intentsById }) => ({
      id: module.id,
      name: module.name,
      description: module.description,
      version: module.version,
      intents: [...intentsById.values()].map((i) =>
        toIntentSummary(module.id, i),
      ),
    }));
  }

  listIntents(): PaletteIntentSummary[] {
    const out: PaletteIntentSummary[] = [];
    for (const { module, intentsById } of this.modules.values()) {
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
    const intent = entry.intentsById.get(intentId);
    if (!intent) {
      return { ok: false, message: `Unknown intent ${moduleId}.${intentId}` };
    }
    try {
      await intent.handler(input, this.ctx);
      return { ok: true };
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
