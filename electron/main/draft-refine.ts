import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { Draft } from '@shared/types';

import type { AuthContext } from './task-runner.js';

const SYSTEM_PROMPT = `You refine an already-drafted reply. Apply the user's edit instruction to the current draft and return ONLY the new draft text. No preamble, no markdown fences, no commentary. Keep the same language and channel norms as the original draft.`;

const CALL_TIMEOUT_MS = 30_000;
const MAX_CHARS = 8_000;

export interface RefineDraftOptions {
  draft: Draft;
  userPrompt: string;
  auth: AuthContext;
  /** Receives the SDK's session_id so the worker turn doesn't leak into
   *  the Observatory (claude-code-watch skips internal sessions). */
  trackSession?: (sessionId: string) => void;
}

export interface RefineResult {
  ok: boolean;
  body?: string;
  message?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildEnv(auth: AuthContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  delete env['ANTHROPIC_API_KEY'];
  delete env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (auth.mode === 'api-key' && auth.apiKey) {
    env['ANTHROPIC_API_KEY'] = auth.apiKey;
  } else if (auth.mode === 'subscription' && auth.claudeOauthToken) {
    env['CLAUDE_CODE_OAUTH_TOKEN'] = auth.claudeOauthToken;
  }
  return env;
}

/**
 * Refine a draft via a one-shot, headless Claude turn. Used by the
 * Drafts view's "Edit with prompt" affordance ("make it shorter",
 * "more formal", etc.).
 *
 * Mirrors `intent-classifier.ts`'s headless-query pattern: query()
 * with maxTurns=1, no tools, no MCPs, claude-haiku-4-5 for sub-2s
 * latency. Registers the session id as internal so the Observatory
 * doesn't show a "jarvis · session XXX" row for every refinement.
 */
export async function refineDraft({
  draft,
  userPrompt,
  auth,
  trackSession,
}: RefineDraftOptions): Promise<RefineResult> {
  // Pre-flight: bail if auth isn't usable. Same checks as the classifier.
  if (auth.mode === 'api-key' && !auth.apiKey) {
    return { ok: false, message: 'No API key configured.' };
  }
  if (auth.mode === 'subscription' && !auth.claudeBinaryPath) {
    return { ok: false, message: 'Claude CLI not available.' };
  }
  const trimmed = userPrompt.trim();
  if (!trimmed) {
    return { ok: false, message: 'Empty edit instruction.' };
  }

  const context = truncate(draft.contextFull ?? '', MAX_CHARS);
  const current = truncate(draft.currentBody, MAX_CHARS);
  const prompt = [
    `Original message context (for reference — do NOT include in the draft):`,
    context || '(none provided)',
    ``,
    `Current draft:`,
    current,
    ``,
    `Edit instruction:`,
    trimmed,
    ``,
    `Return ONLY the new draft text.`,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  try {
    const options: Record<string, unknown> = {
      abortController: controller,
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: 'bypassPermissions',
      env: buildEnv(auth),
      settingSources: [],
      maxTurns: 1,
      allowedTools: [],
      mcpServers: {},
      model: 'claude-haiku-4-5',
    };
    if (auth.mode === 'subscription' && auth.claudeBinaryPath) {
      options['pathToClaudeCodeExecutable'] = auth.claudeBinaryPath;
    }
    const stream = query({
      prompt,
      options: options as Parameters<typeof query>[0]['options'],
    });
    let text = '';
    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      const m = msg as {
        type?: string;
        subtype?: string;
        session_id?: unknown;
        message?: { content?: unknown[] };
      };
      if (
        m.type === 'system' &&
        m.subtype === 'init' &&
        typeof m.session_id === 'string' &&
        trackSession
      ) {
        trackSession(m.session_id);
      }
      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        for (const block of m.message.content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            text += (block as { text: string }).text;
          }
        }
      }
    }
    const body = text.trim();
    if (!body) return { ok: false, message: 'Empty response from model.' };
    return { ok: true, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}
