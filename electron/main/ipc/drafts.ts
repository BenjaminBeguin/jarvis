import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { Draft, DraftStatus } from '@shared/types';

import { refineDraft } from '../draft-refine.js';
import { dispatchDraftSend } from '../draft-send.js';

import type { IpcDeps } from './types.js';

interface ListDraftsArgs {
  status?: DraftStatus | DraftStatus[];
  source?: string;
  channel?: string;
  limit?: number;
}

interface RefineResult {
  ok: boolean;
  draft?: Draft | null;
  message?: string;
}

interface SendResult {
  ok: boolean;
  draft?: Draft | null;
  message?: string;
}

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannels.draftsChanged);
  }
}

export function registerDraftsIpc({ drafts, mcp, runner }: IpcDeps): void {
  // Broadcast on every store mutation. One subscription, fans out to
  // all renderer windows so the Drafts view stays live.
  drafts.on('changed', broadcastChanged);

  ipcMain.handle(IpcChannels.listDrafts, (_e, args: ListDraftsArgs = {}) =>
    drafts.list(args),
  );

  ipcMain.handle(IpcChannels.getDraft, (_e, id: string) => drafts.get(id));

  ipcMain.handle(
    IpcChannels.updateDraftBody,
    (_e, id: string, body: string) => drafts.updateBody(id, body),
  );

  ipcMain.handle(IpcChannels.revertDraft, (_e, id: string) =>
    drafts.revert(id),
  );

  ipcMain.handle(IpcChannels.discardDraft, (_e, id: string) =>
    drafts.discard(id),
  );

  ipcMain.handle(
    IpcChannels.refineDraft,
    async (_e, id: string, prompt: string): Promise<RefineResult> => {
      const draft = drafts.get(id);
      if (!draft) return { ok: false, message: 'Draft not found.' };
      if (draft.status === 'sent' || draft.status === 'discarded') {
        return { ok: false, message: `Draft is ${draft.status} — cannot refine.` };
      }
      const result = await refineDraft({
        draft,
        userPrompt: prompt,
        auth: runner.getAuth(),
        trackSession: (sessionId) => runner.registerInternalSessionId(sessionId),
      });
      if (!result.ok || !result.body) {
        return { ok: false, message: result.message ?? 'Refine failed.' };
      }
      const updated = drafts.updateBody(id, result.body);
      return { ok: true, draft: updated };
    },
  );

  ipcMain.handle(
    IpcChannels.sendDraft,
    async (_e, id: string, actionId?: string): Promise<SendResult> =>
      dispatchDraftSend(drafts, mcp, id, actionId),
  );
}
