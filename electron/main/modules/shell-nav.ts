import type { Module } from './types.js';

/**
 * Verbal navigation: "open settings", "show observatory", "open notes"
 * jump between Shell tabs / module pages without typing a slash prefix.
 *
 * Each intent's handler broadcasts `shell:navigate` with `{ tab, moduleId? }`
 * — the Shell renderer subscribes and updates its tab + openModuleId state.
 * No new task spawns, no Claude call.
 */
const CHANNEL = 'shell:navigate';

interface NavPayload {
  tab: 'observatory' | 'routines' | 'integrations' | 'modules';
  moduleId?: string;
}

export const shellNavModule: Module = {
  id: 'shell-nav',
  name: 'Navigation',
  description: 'Verbal shortcuts to jump between Jarvis pages',
  version: '1.0.0',
  intents: [
    {
      id: 'integrations',
      prefix: '/open-integrations',
      label: 'Open Integrations',
      description: 'MCP integrations & settings',
      verbalTriggers: [
        'open settings',
        'open the settings',
        'show settings',
        'open integrations',
        'show integrations',
        'open the mcp config',
        'open mcp',
        'show mcp',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'integrations' } as NavPayload);
        return 'Opening integrations';
      },
    },
    {
      id: 'observatory',
      prefix: '/open-observatory',
      label: 'Open Observatory',
      description: 'Brain view of everything happening',
      verbalTriggers: [
        'open observatory',
        'show observatory',
        'open the map',
        'show the map',
        'open the brain',
        'show me the brain',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'observatory' } as NavPayload);
        return 'Opening observatory';
      },
    },
    {
      id: 'routines',
      prefix: '/open-routines',
      label: 'Open Routines',
      description: 'Scheduled cron-style routines',
      verbalTriggers: [
        'open routines',
        'show routines',
        'open my routines',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'routines' } as NavPayload);
        return 'Opening routines';
      },
    },
    {
      id: 'modules',
      prefix: '/open-modules',
      label: 'Open Modules',
      description: 'Module manager',
      verbalTriggers: ['open modules', 'show modules', 'show my modules'],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'modules' } as NavPayload);
        return 'Opening modules';
      },
    },
    {
      id: 'notes',
      prefix: '/open-notes',
      label: 'Open Notes',
      description: 'Your daily notes',
      verbalTriggers: [
        'open notes',
        'show notes',
        'open my notes',
        'show my notes',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, {
          tab: 'modules',
          moduleId: 'quick-note',
        } as NavPayload);
        return 'Opening notes';
      },
    },
    {
      id: 'meetings',
      prefix: '/open-meetings',
      label: 'Open Meetings',
      description: 'Recorded meetings + transcripts',
      verbalTriggers: [
        'open meetings',
        'show meetings',
        'open my meetings',
        'show my meetings',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, {
          tab: 'modules',
          moduleId: 'meeting-recorder',
        } as NavPayload);
        return 'Opening meetings';
      },
    },
    {
      id: 'channels',
      prefix: '/open-channels',
      label: 'Open Channels',
      description: '/send integration setup',
      verbalTriggers: ['open channels', 'show channels'],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, {
          tab: 'modules',
          moduleId: 'send',
        } as NavPayload);
        return 'Opening channels';
      },
    },
  ],
};
