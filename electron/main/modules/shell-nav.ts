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
  tab?: 'observatory' | 'inbox' | 'briefings' | 'projects' | 'routines' | 'settings';
  moduleId?: string;
  action?: 'open-new-project';
  /** Free-text payload that accompanies an action (e.g. pre-filled name). */
  initial?: string;
}

export const shellNavModule: Module = {
  id: 'shell-nav',
  name: 'Navigation',
  description: 'Verbal shortcuts to jump between Jarvis pages',
  version: '1.0.0',
  intents: [
    {
      id: 'settings',
      prefix: '/open-settings',
      label: 'Open Settings',
      description: 'Auth, preferences, modules, integrations, API',
      verbalTriggers: [
        'open settings',
        'open the settings',
        'show settings',
        'open integrations',
        'show integrations',
        'open the mcp config',
        'open mcp',
        'show mcp',
        'open preferences',
        'show preferences',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'settings' } as NavPayload);
        return 'Opening settings';
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
      id: 'inbox',
      prefix: '/open-inbox',
      label: 'Open Inbox',
      description: 'Daily triage: PRs, comments, reminders, failed routines',
      verbalTriggers: [
        'open inbox',
        'show inbox',
        'show my inbox',
        'what is waiting for me',
        "what's waiting for me",
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'inbox' } as NavPayload);
        return 'Opening inbox';
      },
    },
    {
      id: 'briefings',
      prefix: '/open-briefings',
      label: 'Open Briefings',
      description: 'Daily recap, weekly retro, today\'s focus — generated digests',
      verbalTriggers: [
        'open briefings',
        'show briefings',
        'show my briefings',
        'show me the recap',
        'show me today',
        "what's the recap",
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'briefings' } as NavPayload);
        return 'Opening briefings';
      },
    },
    {
      id: 'projects',
      prefix: '/open-projects',
      label: 'Open Projects',
      description: 'Project memory + scoped notes/meetings',
      verbalTriggers: [
        'open projects',
        'show projects',
        'open project memory',
        'show project memory',
        'show memory',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'projects' } as NavPayload);
        return 'Opening projects';
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
      description: 'Module manager (now under Settings)',
      verbalTriggers: ['open modules', 'show modules', 'show my modules'],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL, { tab: 'settings' } as NavPayload);
        return 'Opening settings · modules';
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
          tab: 'settings',
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
          tab: 'settings',
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
          tab: 'settings',
          moduleId: 'send',
        } as NavPayload);
        return 'Opening channels';
      },
    },
    {
      id: 'new-project',
      prefix: '/new-project',
      label: 'New project',
      description: 'Add a project to ~/.jarvis/projects.json',
      placeholder: 'Optional name — fills the form for you',
      verbalTriggers: [
        'new project',
        'create project',
        'add a project',
        'add new project',
      ],
      handler: (input, ctx) => {
        const initial = input.trim();
        ctx.broadcast(CHANNEL, {
          action: 'open-new-project',
          initial: initial || undefined,
        } as NavPayload);
        return 'Opening new project dialog';
      },
    },
  ],
};
