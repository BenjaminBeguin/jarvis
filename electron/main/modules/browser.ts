import type { Module } from './types.js';

const BROWSER_MODULE_ID = 'browser';

/**
 * Browser module — owns the Mac-side gate for activity tracking
 * coming from the Chrome extension.
 *
 * The extension reports active-tab URL + title to /v1/browser/
 * activity whenever the user switches tabs / navigates / on a 90s
 * heartbeat. The Mac drops those events into an in-memory ring
 * buffer (browser-activity.ts) and the `browser-activity` context
 * provider surfaces the last ~10 minutes of unique URLs in every
 * Claude turn's system prompt.
 *
 * This module's settings are the user-facing kill switch:
 *   - activityTracking — when false, the Mac side ignores incoming
 *     events even if the extension is still sending them. Belt-and-
 *     suspenders: the extension's own toggle (set in the popup) is
 *     the primary source-side control; this is the second wall.
 *   - activityExcludes — comma-separated URL substrings the
 *     extension drops before they leave the browser. Defaults
 *     cover common-sensitive domains (banking, health, etc.).
 *
 * Setup steps for the underlying extension live in the existing
 * Settings → Browser panel (BrowserExtensionPanel). This module
 * row is JUST the privacy controls + a memory map of where the
 * data lives.
 */
export const browserModule: Module = {
  id: BROWSER_MODULE_ID,
  name: 'Browser',
  description:
    "Receives active-tab activity from the Jarvis Chrome extension and feeds it as ambient context to every Claude turn — so the agent knows what page (PR, ticket, doc) you were just looking at when you ask it something. Default OFF; data never persists to disk.",
  version: '1.0.0',
  settings: {
    description:
      'Activity tracking is OPT-IN. When on, the Chrome extension reports your active tab URL + title every time you switch tabs / navigate. Jarvis keeps the last hour in memory (never written to disk) and surfaces the most recent unique entries as a short context block in each Claude turn. Flip this off and the Mac stops recording immediately — the extension also reads this setting via its periodic refresh and stops sending within ~60s.',
    fields: [
      {
        key: 'activityTracking',
        label: 'Track active tab',
        hint: 'When on, your current browser tab is included in the system prompt of every task Jarvis runs. Off = no signal sent or recorded.',
        type: 'boolean',
        default: false,
      },
      {
        key: 'activityExcludes',
        label: 'Exclude URL patterns',
        hint: 'Comma-separated case-insensitive substrings. Any tab whose URL contains one of these is dropped before it leaves your browser. Defaults are sensible for banking / health / personal mail — add your own.',
        type: 'text',
        default:
          'bank,banking,chase,wellsfargo,paypal,venmo,1password,bitwarden,healthcare,patient,medical,mychart,fidelity,vanguard,coinbase',
      },
    ],
  },
  memory: [
    {
      label: 'Recent active-tab ring buffer',
      location: 'In-memory (session-scoped)',
      kind: 'memory',
      access: 'read-write',
      notes:
        'Last 50 active-tab entries, max 1 hour old. Never written to disk; cleared when Jarvis quits or the module is disabled. See electron/main/browser-activity.ts.',
    },
    {
      label: 'Extension settings on the browser side',
      location: 'Chrome · chrome.storage.local',
      kind: 'config',
      access: 'read-write',
      notes:
        'The Jarvis Chrome extension stores activityTracking + activityExcludes there. Edit via the extension popup OR they sync from this module\'s settings when the extension calls /v1/browser/settings.',
    },
  ],
};
