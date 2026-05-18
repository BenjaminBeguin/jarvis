import type { SetupStep } from './catalog';

/**
 * Per-connector setup walkthrough. Rendered inline next to the
 * Connect button on the Integrations page — shows the user what
 * Jarvis is about to do (and any developer-side prerequisites for
 * connectors whose OAuth client isn't registered yet).
 *
 * Lives in the renderer for now so we don't reshape the server-side
 * Connector interface mid-rollout. Once the OAuth wiring stabilizes
 * we'll move this metadata into each connector's definition and
 * surface it through ConnectorSummary.
 */
export interface ConnectorSetup {
  /** One-paragraph "what's about to happen" shown above the steps. */
  intro: string;
  /** Steps shown as a numbered list. Empty means "no steps, just connect". */
  steps: SetupStep[];
  /** Permission scopes Jarvis will request. Rendered as a list under
   *  the steps. Optional — some providers don't expose scope choices. */
  scopes?: string[];
  /** When true, the connector's OAuth client is hardcoded with a
   *  REPLACE_ME placeholder in its connector source. Surfaces a clear
   *  "developer step required" note so a Connect attempt doesn't fail
   *  with a cryptic error. */
  developerSetupRequired?: boolean;
  /** Path the developer needs to edit (relative to repo root). */
  developerSetupPath?: string;
}

export const CONNECTOR_SETUP: Record<string, ConnectorSetup> = {
  google: {
    intro:
      "We'll open Google's consent screen in your browser. Pick the account you want to connect; tokens come back over 127.0.0.1 and live in Keychain. The same grant covers Gmail + Calendar — no need to register the two separately.",
    steps: [
      {
        title: 'Click Start below',
        body: 'Jarvis opens your browser at Google with the requested scopes. Sign in with whichever account you want to add.',
      },
      {
        title: 'Approve the consent screen',
        body: "Google redirects back to localhost. Jarvis stores the refresh token in Keychain (service: app.jarvis) — never on disk in plaintext.",
      },
      {
        title: 'Add more accounts any time',
        body: 'Click "+ Add account" again to connect a second Google identity (personal + work, etc.). One default account drives /send and the inbox; others are addressable by label.',
      },
    ],
    scopes: [
      'openid · identifies the account',
      'gmail.send · /send via Gmail',
      'gmail.modify · /inbox triage',
      'calendar.events · create + read events',
      'calendar.readonly · proximity nudges',
    ],
  },

  slack: {
    intro:
      "We'll open Slack's consent screen. Pick the workspace + decide whether Jarvis posts as you (xoxp) or as a bot (xoxb). Tokens land in Keychain.",
    steps: [
      {
        title: 'Click Start below',
        body: "Browser opens at slack.com/oauth/v2/authorize with the redirect set to this app.",
      },
      {
        title: 'Pick a workspace and approve',
        body: "Slack shows the requested scopes — chat:write, channels:read, files:write, etc. Confirm.",
        url: 'https://api.slack.com/apps',
        urlLabel: 'Manage apps',
      },
      {
        title: 'Choose post-as preference',
        body: 'After connecting, the "send as" dropdown on the account row picks between bot and user posts. Default is bot.',
      },
    ],
    scopes: [
      'chat:write · post messages',
      'channels:read · list channels',
      'files:write · attach files',
      'users:read · resolve @mentions',
      'search:read · pull inbox',
    ],
    developerSetupRequired: true,
    developerSetupPath: 'electron/main/oauth/connectors/slack.ts',
  },

  notion: {
    intro:
      "Notion uses OAuth for public integrations. Pick the workspace + the pages you want to share — Jarvis only sees pages explicitly added under the integration.",
    steps: [
      {
        title: 'Click Start below',
        body: "Browser opens at notion.so/install with the integration's redirect.",
      },
      {
        title: 'Choose pages to share',
        body: 'Notion lets you pick which workspace + which pages this integration can access. Jarvis cannot see anything you don\'t explicitly add.',
        url: 'https://www.notion.so/profile/integrations',
        urlLabel: 'Manage integrations',
      },
      {
        title: 'Add a second workspace later',
        body: 'Hit "+ Add account" again to repeat for another workspace. One row per workspace.',
      },
    ],
    developerSetupRequired: true,
    developerSetupPath: 'electron/main/oauth/connectors/notion.ts',
  },

  linear: {
    intro:
      "Linear's OAuth is broad-scope by default (read + write on every team you belong to). Tokens are long-lived (~10 years), so refresh isn't a concern.",
    steps: [
      {
        title: 'Click Start below',
        body: 'Browser opens at linear.app/oauth/authorize. Pick the workspace you want connected.',
      },
      {
        title: 'Approve the scopes',
        body: 'read + write across your workspace. Personal API keys had the same effective access.',
        url: 'https://linear.app/settings/api',
        urlLabel: 'Linear API settings',
      },
    ],
    scopes: ['read · everything you can see', 'write · create + edit issues'],
    developerSetupRequired: true,
    developerSetupPath: 'electron/main/oauth/connectors/linear.ts',
  },

  'test-echo': {
    intro:
      "A no-op connector that round-trips the entire OAuth pipeline without touching a real provider. Useful when iterating on the orchestrator + callback handler.",
    steps: [
      {
        title: 'Click Start below',
        body: 'Browser opens a local echo endpoint that immediately redirects with a fake code. The orchestrator stamps a dummy account and stores a placeholder token.',
      },
      {
        title: 'Verify the round-trip',
        body: 'The new account should appear above with a synthetic label. Disconnect to clear it.',
      },
    ],
  },
};

export function getConnectorSetup(id: string): ConnectorSetup | null {
  return CONNECTOR_SETUP[id] ?? null;
}
