import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

import type { Draft, SendAction } from '@shared/types';

import type { DraftsStore } from './drafts-store.js';
import type { McpConfigStore } from './mcp-config.js';
import { invokeMcpTool } from './mcp-invoke.js';

/**
 * Allowlist for shell-kind sendActions. We never honor an arbitrary
 * `cmd` from a draft. The agent + workflow are trusted to pick the
 * right tool, but the dispatch pins the executable so a misconfigured
 * sendAction can't run arbitrary commands.
 */
const SHELL_CMD_ALLOWLIST = new Set(['gh']);

interface ShellSendResult {
  ok: boolean;
  stdout?: string;
  message?: string;
}

export interface DispatchDraftResult {
  ok: boolean;
  draft?: Draft | null;
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
      (execErr, stdout, stderr) => {
        if (execErr) {
          const msg =
            stderr?.toString().trim() || execErr.message || 'shell send failed';
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

/**
 * Dispatch one of a draft's actions. Picks the action by `actionId`
 * if supplied, otherwise the action flagged `primary`, otherwise the
 * first. Marks the draft `sending` → `sent` / `failed` along the way,
 * persisting the result payload. Returns the final draft + a
 * success / error message.
 *
 * Shared between the IPC `drafts:send` handler (UI Send button) and
 * the MCP `send_draft` tool (agent dispatch) so both paths go through
 * the same dispatch logic + allowlist + body substitution rules.
 */
export async function dispatchDraftSend(
  drafts: DraftsStore,
  mcp: McpConfigStore,
  id: string,
  actionId?: string,
): Promise<DispatchDraftResult> {
  const draft = drafts.get(id);
  if (!draft) return { ok: false, message: 'Draft not found.' };
  if (draft.status === 'sent') {
    return { ok: false, draft, message: 'Already sent.' };
  }
  if (draft.status === 'sending') {
    return { ok: false, draft, message: 'Send in progress.' };
  }
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
  const consumesBody =
    action.requiresBody !== false && typeof sendAction.bodyKey === 'string';
  const args: Record<string, unknown> = consumesBody
    ? { ...sendAction.args, [sendAction.bodyKey as string]: draft.currentBody }
    : { ...sendAction.args };
  const result = await invokeMcpTool(mcp, sendAction.mcp, sendAction.tool, args);
  if (!result.ok || result.isError) {
    const message =
      result.message ??
      (result.isError ? 'MCP server flagged the call as failed.' : 'Send failed.');
    drafts.markFailed(id, message);
    return { ok: false, draft: drafts.get(id), message };
  }
  const sentDraft = drafts.markSent(id, result.content ?? null);
  return { ok: true, draft: sentDraft };
}
