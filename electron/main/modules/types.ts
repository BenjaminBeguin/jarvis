import type { LaunchTaskRequest, TaskSummary } from '@shared/types';

/**
 * What a module receives at load time. Stays stable across the module's
 * lifetime. New capabilities should land here so modules don't have to import
 * from random main-process files.
 */
export interface ModuleContext {
  /** ~/.jarvis on disk — modules should put their data under a subdir. */
  readonly jarvisRoot: string;
  /** Native macOS notification. Click jumps to the observatory. */
  notify(title: string, body: string): void;
  /** Fire a Task into the runner. Useful when a module wants to chain into Claude. */
  launchTask(req: LaunchTaskRequest): TaskSummary;
}

/**
 * A palette intent. The palette routes `<prefix> <input>` to `handler(input)`.
 * Prefix must start with `/` and be a single token (no spaces).
 */
export interface PaletteIntent {
  id: string;
  prefix: string;
  label: string;
  description?: string;
  placeholder?: string;
  handler: (input: string, ctx: ModuleContext) => void | Promise<void>;
}

/**
 * The thing every module exports. Keep it small and code-only; manifests
 * masquerading as data are a footgun once you have many modules.
 */
export interface Module {
  id: string;
  name: string;
  description: string;
  version: string;
  intents?: PaletteIntent[];
  onLoad?(ctx: ModuleContext): void | Promise<void>;
  onUnload?(): void | Promise<void>;
}
