import type { Module } from './types.js';

/**
 * Direct shell execution — `/sh <cmd>` (or `> <cmd>` verbal trigger) runs
 * the command in $HOME with shell:true, streams stdout + stderr into the
 * HUD as if it were an agent task, and gives the Stop button the right
 * behavior (kills the child via SIGTERM).
 *
 * This is the universal "I know what I want, just run it" backup for
 * anything Claude is otherwise doing for you. Costs nothing — no LLM in
 * the loop.
 */
export const shellModule: Module = {
  id: 'shell',
  name: 'Shell',
  description: 'Run a shell command directly (no Claude in the loop)',
  version: '1.0.0',
  intents: [
    {
      id: 'sh',
      prefix: '/sh',
      label: 'Run shell command',
      description: 'Spawn the command in $HOME and stream output to the HUD',
      placeholder: 'e.g. "git status" or "ls ~/.jarvis"',
      verbalTriggers: ['>'],
      handler: (input, ctx) => {
        const cmd = input.trim();
        if (!cmd) {
          ctx.notify('Shell', 'Give me a command — e.g. `/sh ls -la`');
          return 'Need a command.';
        }
        const t = ctx.runShell(cmd);
        ctx.showHud(t.id);
        return `Running · ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`;
      },
    },
  ],
};
