import type { Module } from './types.js';

/**
 * /send — palette shortcut to the `send` skill. The skill knows about your
 * connected MCPs (Slack, Gmail accounts, iMessage) and routes the message
 * to the right channel after showing you a preview and waiting for "send".
 * Multi-turn happens in the HUD reply box.
 */
export const sendModule: Module = {
  id: 'send',
  name: 'Send',
  description: 'Send a message via Slack, Gmail, or iMessage with a channel-aware Claude assist',
  version: '1.0.0',
  intents: [
    {
      id: 'send',
      prefix: '/send',
      label: 'Send to someone',
      description: 'Pick a channel + recipient; preview before firing',
      placeholder: 'who · channel · what (e.g. "Luca slack: I\'ll be 5 min late")',
      handler: (input, ctx) => {
        const body = input.trim();
        if (!body) {
          ctx.notify('Send', 'Tell me who + channel + what to say.');
          return 'Need a recipient + channel + message.';
        }
        const t = ctx.launchTask({
          prompt: body,
          skillId: 'send',
          origin: 'palette',
        });
        ctx.showHud(t.id);
        return `Drafting · #${t.id.slice(0, 6)}`;
      },
    },
  ],
};
