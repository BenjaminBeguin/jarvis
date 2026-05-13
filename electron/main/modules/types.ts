import type { LaunchTaskRequest, TaskStatus, TaskSummary } from '@shared/types';

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
  /** Publish an observable entry the module is watching (not running). */
  registerExternalTask(summary: TaskSummary): void;
  /** Push a streamed event for a previously-registered external entry. */
  recordExternalEvent(taskId: string, msg: unknown): void;
  /** Update the running/idle/completed state of an external entry. */
  updateExternalTaskStatus(
    taskId: string,
    status: TaskStatus,
    endedAt: number | null,
  ): void;
  /** Patch arbitrary fields on an external entry (e.g. awaitingInput). */
  updateExternalTaskMeta(taskId: string, patch: Partial<TaskSummary>): void;
  /** True if Jarvis already has an external entry with that id. */
  hasExternalTask(id: string): boolean;
  /** True if any Jarvis-owned task is bound to this claude session id. */
  isOwnedSessionId(sessionId: string): boolean;
  /** Drop an external entry (used to dedupe mirrors of owned sessions). */
  removeExternalTask(taskId: string): void;
}

/**
 * A palette intent. The palette routes `<prefix> <input>` to `handler(input)`.
 * Prefix must start with `/` and be a single token (no spaces).
 *
 * Handlers may return a short string that's surfaced to the user as a "what
 * just happened" message (palette success badge, notification body).
 */
export interface PaletteIntent {
  id: string;
  prefix: string;
  label: string;
  description?: string;
  placeholder?: string;
  handler: (
    input: string,
    ctx: ModuleContext,
  ) => void | string | Promise<void | string>;
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
