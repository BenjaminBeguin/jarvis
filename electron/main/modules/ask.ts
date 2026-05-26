import type { Module } from './types.js';

/**
 * Ask Jarvis — the explicit conversational entry point.
 *
 * Free-text in the palette already routes to a default Claude task
 * with no skill, picking up the (now-sharp) DEFAULT_SYSTEM_PROMPT
 * from task-runner.ts. This module adds:
 *
 *   1. A discoverable `/ask` prefix so users have a clear "talk to
 *      Jarvis" path.
 *   2. Verbal triggers that map naturally to "I want a thinking
 *      partner answer, not a routed command." These bypass the
 *      module-intent fallthrough so a phrase like "what should I
 *      do today" doesn't get mis-classified as a status / reminder
 *      / note dispatch.
 *
 * The handler itself is a thin pass-through: launch a no-skill task
 * with the user's input as the prompt. The DEFAULT_SYSTEM_PROMPT
 * carries the Jarvis voice + tool guidance + reference to the
 * context providers; the task auto-inherits all that.
 *
 * Same task surface as any other: streams in the conversation view,
 * supports follow-up replies, can escalate via the ↑ button.
 */
export const askModule: Module = {
  id: 'ask',
  name: 'Ask Jarvis',
  description:
    'Conversational entry point. Type /ask or use one of the verbal triggers to skip module-intent routing and get a direct, opinionated Jarvis answer with the full context block (calendar, inbox, learnings, recent tasks).',
  version: '1.0.0',
  intents: [
    {
      id: 'ask',
      prefix: '/ask',
      label: 'Ask Jarvis',
      description:
        'Direct question to Jarvis — uses the rich context block and gives a specific, opinionated answer. Bypasses other intent routing.',
      placeholder: 'what should I work on next? / status of csai / etc.',
      verbalTriggers: [
        // Direct address — clear "talk to me" signal.
        'hey jarvis',
        'jarvis',
        'ask jarvis',
        // "Tell me" / "what" patterns most commonly mean the user
        // wants a synthesised answer, not a routed command.
        'tell me',
        'what should i',
        'what do you think',
        'what do you recommend',
        'what would you',
        'what is the status',
        'how is',
        'how are',
        // Open-ended "help me" — needs Jarvis judgment.
        'help me decide',
        'help me think',
      ],
      handler: (input, ctx) => {
        const prompt = input.trim();
        if (!prompt) {
          return 'Ask me something. e.g. "/ask what should I work on next?"';
        }
        const t = ctx.launchTask({
          // No skillId — falls back to DEFAULT_SYSTEM_PROMPT, which
          // carries the Jarvis assistant persona. The context block
          // (calendar / inbox / learnings / etc.) auto-injects.
          prompt,
          origin: 'palette',
        });
        ctx.showHud(t.id);
        return `Asking · #${t.id.slice(0, 6)}`;
      },
    },
  ],
};
