import type { AuthMode, RoutePromptResult, SessionConfig, TaskOrigin } from '@shared/types';

import { parseIntent } from './intent-router.js';
import type { ModuleRegistry } from './module-registry.js';
import type { ReminderStore } from './reminders.js';
import type { Reminder } from '@shared/types';
import { asTaskOrigin, type TaskRunner } from './task-runner.js';

export interface RoutePromptDeps {
  modules: ModuleRegistry;
  reminders: ReminderStore;
  runner: TaskRunner;
  /** Returns the current auth status so we can fail fast with a useful
   *  message when the user routes a task before configuring auth. */
  authStatus: () => Promise<{
    authMode: AuthMode | null;
    hasApiKey: boolean;
    claudeBinaryPath: string | null;
  }>;
  /** Optional callback invoked when a reminder is created via routing —
   *  the IPC handler uses this to fire the inline "Reminder set" toast,
   *  while a non-renderer caller (e.g. Telegram bot) can skip it. */
  onReminderCreated?: (reminder: Reminder, opts: { hadCron: boolean }) => void;
}

export interface RoutePromptOpts {
  origin?: TaskOrigin | 'palette' | 'voice';
  sessionConfig?: SessionConfig;
  projectName?: string | null;
}

/**
 * Unified palette → action dispatcher. Same logic regardless of caller
 * (IPC from the renderer palette OR `ctx.routePrompt` from a module like
 * the Telegram bot). Order of operations:
 *
 *   1. Verbal-intent match against registered modules.
 *   2. parseIntent → if reminder, create + return.
 *   3. Otherwise launch a Claude task (auth-gated).
 */
export async function routePrompt(
  prompt: string,
  opts: RoutePromptOpts,
  deps: RoutePromptDeps,
): Promise<RoutePromptResult> {
  const text = typeof prompt === 'string' ? prompt : '';

  const verbal = deps.modules.matchVerbal(text);
  if (verbal) {
    const result = await deps.modules.dispatch(
      verbal.moduleId,
      verbal.intentId,
      verbal.rest,
    );
    return {
      kind: 'intent',
      moduleId: verbal.moduleId,
      intentId: verbal.intentId,
      ok: result.ok,
      message: result.message,
    };
  }

  const intent = parseIntent(text);
  if (intent.kind === 'reminder') {
    const reminder = deps.reminders.create({
      body: intent.body,
      mode: intent.mode,
      fireAt: intent.fireAt,
      cron: intent.cron,
    });
    deps.onReminderCreated?.(reminder, { hadCron: !!intent.cron });
    return { kind: 'reminder', reminder };
  }

  const status = await deps.authStatus();
  if (!status.authMode) throw new Error('Pick an auth mode first.');
  if (status.authMode === 'api-key' && !status.hasApiKey) {
    throw new Error('Add an API key first.');
  }
  if (status.authMode === 'subscription' && !status.claudeBinaryPath) {
    throw new Error(
      'Claude Code CLI not found. Run `claude login` or switch to API-key mode.',
    );
  }
  const task = deps.runner.launch({
    prompt: intent.body,
    origin: asTaskOrigin(opts.origin),
    ...(opts.sessionConfig ?? {}),
    ...(opts.projectName !== undefined ? { projectName: opts.projectName } : {}),
  });
  return { kind: 'task', task };
}
