import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { SessionConfig } from '@shared/types';

import { prewarmEagerRag } from '../artifacts/index.js';
import { loadActiveWorkspaceId } from '../auth.js';
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
  activity,
  userContext,
  workspaces,
}: IpcDeps): void {
  ipcMain.handle(IpcChannels.previewIntent, (_e, prompt: string) => {
    if (typeof prompt !== 'string') return { kind: 'task', body: '' };
    return parseIntent(prompt);
  });

  // Speculative eager-RAG prewarm. Renderer debounces on the user's
  // keystrokes so by the time they press Enter, the LRU is already
  // populated and the launch path skips the search-worker round-trip.
  // Pure fan-and-forget — never throws.
  ipcMain.on(IpcChannels.prewarmAsk, (_e, prompt: unknown) => {
    if (typeof prompt !== 'string' || prompt.length < 12) return;
    try {
      prewarmEagerRag(prompt, userContext.getActiveProject());
    } catch {
      // Swallow — prewarm failures must never leak to the renderer.
    }
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
          activeWorkspaceId: () =>
            loadActiveWorkspaceId() ?? workspaces.getDefault().id,
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
            // Mirror to Activity — palette free-text path was silent
            // (only the /remind intent module logged it). Now any
            // "remind me in 2h …" typed in the palette OR sent via
            // Telegram produces an Activity row at create time, not
            // just when it fires.
            activity.record({
              kind: 'reminder.created',
              label: `${title} · ${reminder.body.slice(0, 80)}${reminder.body.length > 80 ? '…' : ''}`,
              detail: {
                reminderId: reminder.id,
                mode: reminder.mode,
                fireAt: reminder.fireAt,
                cron: hadCron ? reminder.cron ?? null : null,
              },
            });
          },
        },
      );
    },
  );
}
