import type { AuthMode, RoutePromptResult, SessionConfig, TaskOrigin } from '@shared/types';

import { loadVoiceAlwaysSpeak } from './auth.js';
import { matchSkillIntent, parseIntent } from './intent-router.js';
import { modelForTier } from './model-tiers.js';
import type { ModuleRegistry } from './module-registry.js';
import type { ReminderStore } from './reminders.js';
import type { Reminder } from '@shared/types';
import { asTaskOrigin, type TaskRunner } from './task-runner.js';

/**
 * Decide whether a free-text ask is "snappy enough" to run on the
 * fast tier (Haiku) instead of the balanced default (Sonnet). Saves
 * ~300–600ms time-to-first-token on the common "quick question"
 * pattern while leaving anything that smells like real work on the
 * regular path.
 *
 * Conservative gate — when in doubt, stay on the default tier.
 * If Haiku gets a question it can't handle, the agent can call
 * `mcp__jarvis__think_harder` to escalate mid-flight (the runner
 * preserves session continuity), so an under-tier is recoverable.
 */
function shouldUseFastTier(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  // Lines with code-shaped content read as dev work — leave on Sonnet.
  if (/```|`[^`\n]+`|\b(class|function|const|let|var|import|export)\b/.test(trimmed)) {
    return false;
  }
  // Explicit "think hard" hints — user wants the smart tier.
  if (/\b(think hard|deep|analyse|analyze|reason|architect|design)\b/i.test(trimmed)) {
    return false;
  }
  // Multi-paragraph asks usually carry more context / expect more work.
  if ((trimmed.match(/\n/g) ?? []).length > 1) return false;
  // Question-shaped or status-shaped — typical fast-tier candidates.
  if (/\?/.test(trimmed)) return true;
  if (/^(what|where|when|why|who|which|how|is|are|do|does|did|can|could|should)\b/i.test(trimmed)) {
    return true;
  }
  if (/^(show|tell|find|list|summari[sz]e|recap|status|update)\b/i.test(trimmed)) return true;
  return false;
}

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
  // Skill auto-pick: phrases like "what's my update today" bind to
  // /status (Haiku + pooled session) instead of a free-form launch.
  // Big latency win — pooled skills skip the cold-start + tool
  // inventory bootstrap.
  const skillId = matchSkillIntent(intent.body);

  // "Always read replies aloud" preference: if the caller didn't
  // explicitly set speakReply, fall back to the global setting.
  // Lets the user enable read-aloud once in Settings → Voice and
  // have it apply to every palette / voice / module dispatch.
  const baseConfig = opts.sessionConfig ?? {};
  const sessionConfig: SessionConfig =
    baseConfig.speakReply === undefined && loadVoiceAlwaysSpeak()
      ? { ...baseConfig, speakReply: true }
      : baseConfig;

  // Auto-pick fast tier for short conversational asks (no skill, no
  // explicit model). Skill dispatches keep their declared tier; the
  // user's caller-supplied model in sessionConfig wins over our hint.
  // Falls back silently to the default tier when none of the
  // heuristics match — see shouldUseFastTier.
  const wantFastTier =
    !skillId && !sessionConfig.model && shouldUseFastTier(intent.body);
  const tierHint: Partial<SessionConfig> = wantFastTier
    ? { model: modelForTier('fast') }
    : {};

  const task = deps.runner.launch({
    prompt: intent.body,
    origin: asTaskOrigin(opts.origin),
    ...(skillId ? { skillId } : {}),
    ...sessionConfig,
    ...tierHint,
    ...(opts.projectName !== undefined ? { projectName: opts.projectName } : {}),
  });
  return { kind: 'task', task };
}
