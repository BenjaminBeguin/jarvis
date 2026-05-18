import type { SetupStep } from './catalog';

/**
 * Per-connector setup walkthrough. Rendered inline next to the
 * Connect button on the Integrations page. The credentials form
 * (rendered separately by ConnectedAccounts.tsx based on the
 * connector's `credentialSpec`) handles the client_id / client_secret
 * input — these steps describe HOW to obtain those credentials from
 * the provider's developer console, plus any other one-time setup the
 * user needs to do before approving consent.
 *
 * The redirect URI all four providers expect is
 *   http://127.0.0.1:4747/oauth/callback/<connectorId>
 * because Jarvis's local HTTP server is the OAuth callback target.
 */
export interface ConnectorSetup {
  /** One-paragraph "what's about to happen" shown above the steps. */
  intro: string;
  /** Steps shown as a numbered list. Empty means "no steps, just connect". */
  steps: SetupStep[];
  /** Permission scopes Jarvis will request. Rendered as a list under
   *  the steps. Optional — some providers don't expose scope choices. */
  scopes?: string[];
}

export const CONNECTOR_SETUP: Record<string, ConnectorSetup> = {
  google: {
    intro:
      "Gmail + Calendar in one consent flow. Tokens come back over 127.0.0.1 and land in Keychain (service: app.jarvis). Auto-refreshes ~10 minutes before expiry.",
    steps: [
      {
        title: 'Open Google Cloud Console',
        body: 'Pick or create a project. Enable the Gmail API and Google Calendar API under "APIs & Services → Library".',
        url: 'https://console.cloud.google.com/apis/credentials',
        urlLabel: 'Credentials',
      },
      {
        title: 'Configure the OAuth consent screen',
        body: 'External user type. App name "Jarvis", your email as support contact. Add scopes: openid, email, profile, gmail.modify, gmail.send, calendar. While in Testing mode add yourself as a Test User and grant freely.',
      },
      {
        title: 'Create the OAuth client',
        body: 'Credentials → Create credentials → OAuth client ID. Application type: Desktop app (PKCE — no secret) OR Web application (with secret). If you pick Web, add redirect URI: http://127.0.0.1:4747/oauth/callback/google',
      },
      {
        title: 'Paste credentials below',
        body: 'Copy the Client ID; for Web-app clients also copy the Client Secret. Paste into the form above and Save.',
      },
      {
        title: 'Click Start OAuth flow',
        body: 'Browser opens at Google\'s consent screen. Sign in with the Google account you want to add. Tokens land in Keychain.',
      },
    ],
    scopes: [
      'openid · identifies the account',
      'gmail.modify · read + label triage',
      'gmail.send · send via Gmail',
      'calendar · list + create events',
    ],
  },

  slack: {
    intro:
      "One Slack OAuth grant gives Jarvis both a bot token (xoxb-) and a user token (xoxp-). After connecting, flip the per-account 'send as' dropdown to switch chat.postMessage between bot and you.",
    steps: [
      {
        title: 'Create a Slack app',
        body: '"From scratch", pick your workspace, give it a name.',
        url: 'https://api.slack.com/apps',
        urlLabel: 'Manage apps',
      },
      {
        title: 'Configure OAuth & Permissions',
        body: 'Add redirect URL: http://127.0.0.1:4747/oauth/callback/slack. Bot Token Scopes: chat:write, chat:write.public, channels:read, groups:read, users:read, users:read.email, search:read. User Token Scopes: chat:write, search:read.',
      },
      {
        title: 'Copy Basic Information',
        body: 'Settings → Basic Information. Copy Client ID and Client Secret. Both are required.',
      },
      {
        title: 'Paste credentials below',
        body: 'Paste both into the form above and Save.',
      },
      {
        title: 'Click Start OAuth flow',
        body: 'Browser opens at slack.com/oauth/v2/authorize. Pick the workspace, approve both scope sets.',
      },
    ],
    scopes: [
      'bot · chat:write · post in channels',
      'bot · channels:read · list channels',
      'bot · users:read · resolve @mentions',
      'bot · search:read · search messages',
      'user · chat:write · post as you (when sendAs=user)',
      'user · search:read · search as you',
    ],
  },

  notion: {
    intro:
      "Notion uses a public-integration OAuth flow. Tokens are workspace-scoped, long-lived (no refresh). Notion gates access per-page — you pick which pages the integration can see during consent.",
    steps: [
      {
        title: 'Create a public integration',
        body: '"+ New integration" → Public integration. Enable read content, update content, insert content (and comments/databases as needed).',
        url: 'https://www.notion.so/profile/integrations',
        urlLabel: 'Manage integrations',
      },
      {
        title: 'Configure OAuth Domain & URIs',
        body: 'Redirect URIs: add http://127.0.0.1:4747/oauth/callback/notion',
      },
      {
        title: 'Copy Secrets',
        body: 'Secrets section: copy OAuth client ID and OAuth client secret. Both required.',
      },
      {
        title: 'Paste credentials below',
        body: 'Paste into the form above and Save.',
      },
      {
        title: 'Click Start OAuth flow',
        body: 'Browser opens at notion.so. Pick the workspace + the pages/databases the integration should see. Jarvis can only access pages you explicitly grant.',
      },
    ],
  },

  linear: {
    intro:
      "Linear OAuth with PKCE — no client_secret to manage. Tokens last 10 years by default and refresh transparently.",
    steps: [
      {
        title: 'Create a Linear OAuth application',
        body: 'Settings → API → "Create new application". Name + URL whatever you like.',
        url: 'https://linear.app/settings/api/applications',
        urlLabel: 'Linear API applications',
      },
      {
        title: 'Configure callback URLs',
        body: 'Callback URLs: http://127.0.0.1:4747/oauth/callback/linear',
      },
      {
        title: 'Copy the Client ID',
        body: 'Linear shows the Client ID on the application page. PKCE means you do NOT need the client secret — leave that field blank in Jarvis.',
      },
      {
        title: 'Paste credentials below',
        body: 'Paste the Client ID into the form above and Save (Client Secret stays blank).',
      },
      {
        title: 'Click Start OAuth flow',
        body: 'Browser opens at linear.app. Approve the read + write scopes for your workspace.',
      },
    ],
    scopes: ['read · everything you can see', 'write · create + edit issues, comments'],
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
