import { Notification, ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';

import { parseIntent } from '../intent-router.js';
import { asTaskOrigin } from '../task-runner.js';
import { openObservatory } from '../windows.js';
import type { IpcDeps } from './types.js';

/**
 * Routes for parsing palette free-text and converting it into a task,
 * reminder, or module intent. Same auth gate as launchTask — but inline,
 * to avoid a second IPC hop after routing.
 */
export function registerIntentIpc({
  modules,
  reminders,
  runner,
  auth,
}: IpcDeps): void {
  ipcMain.handle(IpcChannels.previewIntent, (_e, prompt: string) => {
    if (typeof prompt !== 'string') return { kind: 'task', body: '' };
    return parseIntent(prompt);
  });

  ipcMain.handle(
    IpcChannels.routePrompt,
    async (
      _e,
      payload: { prompt: string; origin?: 'palette' | 'voice' },
    ) => {
      const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
      // 1. Verbal intent match: "record the meeting" → meeting/start, etc.
      //    Routed BEFORE parseIntent so module-owned phrases win over the
      //    reminder parser (a phrase like 'remind me to record the meeting'
      //    still parses as a reminder because the leading word is 'remind').
      const verbal = modules.matchVerbal(prompt);
      if (verbal) {
        const result = await modules.dispatch(
          verbal.moduleId,
          verbal.intentId,
          verbal.rest,
        );
        return {
          kind: 'intent' as const,
          moduleId: verbal.moduleId,
          intentId: verbal.intentId,
          ok: result.ok,
          message: result.message,
        };
      }
      const intent = parseIntent(prompt);
      if (intent.kind === 'reminder') {
        const reminder = reminders.create({
          body: intent.body,
          mode: intent.mode,
          fireAt: intent.fireAt,
        });
        try {
          const when = new Date(reminder.fireAt).toLocaleString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            day: 'numeric',
            month: 'short',
          });
          const title =
            intent.mode === 'scheduled'
              ? `Scheduled · ${when}`
              : `Reminder set · ${when}`;
          new Notification({ title, body: reminder.body, silent: true })
            .on('click', () => openObservatory())
            .show();
        } catch {
          // Notifications can fail pre-permission; the reminder is still
          // scheduled.
        }
        return { kind: 'reminder' as const, reminder };
      }
      // Fall through to a normal task launch.
      const status = await auth.refresh();
      if (!status.authMode) throw new Error('Pick an auth mode first.');
      if (status.authMode === 'api-key' && !status.hasApiKey) {
        throw new Error('Add an API key first.');
      }
      if (status.authMode === 'subscription' && !status.claudeBinaryPath) {
        throw new Error(
          'Claude Code CLI not found. Run `claude login` or switch to API-key mode.',
        );
      }
      const task = runner.launch({
        prompt: intent.body,
        origin: asTaskOrigin(payload?.origin),
      });
      return { kind: 'task' as const, task };
    },
  );
}
