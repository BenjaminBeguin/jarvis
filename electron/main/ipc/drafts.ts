import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { Draft, DraftStatus, SendAction } from '@shared/types';

import { refineDraft } from '../draft-refine.js';
import { invokeMcpTool } from '../mcp-invoke.js';

import type { IpcDeps } from './types.js';

/**
 * Allowlist for shell-kind sendActions. We never honor an arbitrary
 * `cmd` from a draft. The agent + workflow are trusted to pick the
 * right tool, but the IPC pins the executable so a misconfigured
 * sendAction can't run arbitrary commands.
 */
const SHELL_CMD_ALLOWLIST = new Set(['gh']);

interface ShellSendResult {
  ok: boolean;
  stdout?: string;
  message?: string;
}

/**
 * Replace both substitution tokens in a string in a single pass.
 *   - `{body}`      → literal body
 *   - `{body_json}` → JSON.stringify(body)  (with surrounding quotes)
 *
 * Single-pass is required: a sequential two-pass approach (replace
 * `{body_json}` first, then `{body}`) corrupts the result if the
 * user's body itself contains the literal string `{body}` — the
 * second pass would re-substitute inside the just-encoded JSON.
 */
function substituteTokens(s: string, body: string): string {
  return s.replace(/\{body_json\}|\{body\}/g, (token) =>
    token === '{body_json}' ? JSON.stringify(body) : body,
  );
}

function runShellSend(
  action: Extract<SendAction, { kind: 'shell' }>,
  body: string,
): Promise<ShellSendResult> {
  return new Promise((resolve) => {
    if (!SHELL_CMD_ALLOWLIST.has(action.cmd)) {
      resolve({
        ok: false,
        message: `Shell sendAction cmd '${action.cmd}' is not on the allowlist.`,
      });
      return;
    }
    const args = action.args.map((a) =>
      typeof a === 'string' ? substituteTokens(a, body) : a,
    );
    const child = execFile(
      action.cmd,
      args,
      {
        cwd: action.cwd ?? homedir(),
        timeout: action.timeoutMs ?? 30_000,
        env: process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg =
            stderr?.toString().trim() || err.message || 'shell send failed';
          resolve({ ok: false, message: msg });
        } else {
          resolve({ ok: true, stdout: stdout.toString() });
        }
      },
    );
    if (action.stdin !== undefined && child.stdin) {
      try {
        child.stdin.write(substituteTokens(action.stdin, body));
        child.stdin.end();
      } catch {
        // execFile callback will surface the error
      }
    }
  });
}

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
    async (_e, id: string, actionId?: string): Promise<SendResult> => {
      const draft = drafts.get(id);
      if (!draft) return { ok: false, message: 'Draft not found.' };
      if (draft.status === 'sent') {
        return { ok: false, draft, message: 'Already sent.' };
      }
      if (draft.status === 'sending') {
        return { ok: false, draft, message: 'Send in progress.' };
      }
      // Pick the action: explicit by id, else the primary, else the
      // first. Single-action drafts (legacy / simple) work without
      // the caller supplying an actionId at all.
      const action =
        (actionId && draft.actions.find((a) => a.id === actionId)) ||
        draft.actions.find((a) => a.primary) ||
        draft.actions[0];
      if (!action) {
        return {
          ok: false,
          draft,
          message: 'Draft has no actions — cannot dispatch.',
        };
      }
      const { sendAction } = action;
      // Dispatch on kind. Default (omitted) is 'mcp' for backwards
      // compat with the original Gmail/Slack drafts.
      if (sendAction.kind === 'shell') {
        if (!sendAction.cmd || !Array.isArray(sendAction.args)) {
          return {
            ok: false,
            draft,
            message: 'Shell sendAction is malformed.',
          };
        }
        drafts.markSending(id);
        const result = await runShellSend(sendAction, draft.currentBody);
        if (!result.ok) {
          drafts.markFailed(id, result.message ?? 'shell send failed');
          return { ok: false, draft: drafts.get(id), message: result.message };
        }
        const sentDraft = drafts.markSent(id, result.stdout ?? null);
        return { ok: true, draft: sentDraft };
      }
      // mcp kind (default)
      if (!sendAction.mcp || !sendAction.tool) {
        return {
          ok: false,
          draft,
          message: 'Draft action is missing mcp/tool — cannot dispatch.',
        };
      }
      drafts.markSending(id);
      // Substitute the editable body into the configured arg slot
      // when bodyKey is set AND the action expects a body. Body-less
      // actions (archive, label-as, forward-to-fixed, etc.) omit
      // bodyKey and/or set requiresBody=false; the args go through
      // verbatim.
      const consumesBody =
        action.requiresBody !== false && typeof sendAction.bodyKey === 'string';
      const args: Record<string, unknown> = consumesBody
        ? { ...sendAction.args, [sendAction.bodyKey as string]: draft.currentBody }
        : { ...sendAction.args };
      const result = await invokeMcpTool(
        mcp,
        sendAction.mcp,
        sendAction.tool,
        args,
      );
      if (!result.ok || result.isError) {
        const message =
          result.message ??
          (result.isError ? 'MCP server flagged the call as failed.' : 'Send failed.');
        drafts.markFailed(id, message);
        return { ok: false, draft: drafts.get(id), message };
      }
      const sentDraft = drafts.markSent(id, result.content ?? null);
      return { ok: true, draft: sentDraft };
    },
  );
}
