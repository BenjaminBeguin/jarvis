import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { SessionConfig } from '@shared/types';

import { parseIntent } from '../intent-router.js';
import { notifier } from '../notifier.js';
import { routePrompt as routePromptShared } from '../route-prompt.js';
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
      payload: {
        prompt: string;
        origin?: 'palette' | 'voice';
        sessionConfig?: SessionConfig;
      },
    ) => {
      return routePromptShared(
        typeof payload?.prompt === 'string' ? payload.prompt : '',
        {
          origin: payload?.origin,
          sessionConfig: payload?.sessionConfig,
        },
        {
          modules,
          reminders,
          runner,
          authStatus: auth.refresh,
          onReminderCreated: (reminder, { hadCron }) => {
            const when = new Date(reminder.fireAt).toLocaleString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              day: 'numeric',
              month: 'short',
            });
            const recurringSuffix = hadCron ? ' · recurring' : '';
            const title =
              reminder.mode === 'scheduled'
                ? `Scheduled · ${when}${recurringSuffix}`
                : `Reminder set · ${when}${recurringSuffix}`;
            notifier.post({
              source: 'reminder-created',
              title,
              body: reminder.body,
              reminderId: reminder.id,
              silent: true,
              onClick: () => openObservatory(),
            });
          },
        },
      );
    },
  );
}
