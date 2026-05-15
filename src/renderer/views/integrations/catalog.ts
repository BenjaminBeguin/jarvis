/**
 * Curated MCP catalog. Each entry knows the stdio spawn command + a
 * description of the env vars it needs, so the Integrations page can
 * render a friendly form (instead of asking the user to write JSON).
 *
 * `aliases` is the set of names the catalog entry matches against in
 * `claude mcp list` and ~/.jarvis/mcp.json. For example, Slack might
 * appear as 'Slack' (claude.ai) or 'slack' (jarvis-local) — both
 * indicate "Slack is connected".
 *
 * Adding a new entry: drop it in CATALOG. The page picks it up
 * automatically.
 */

export interface CatalogField {
  key: string;
  label: string;
  placeholder?: string;
  /** secret = use a password-style input; text = visible. */
  kind: 'secret' | 'text';
  required?: boolean;
  /** Help text shown directly under the field. */
  hint?: string;
}

/**
 * One numbered step in a guided setup walkthrough. Richer than
 * `setupNotes` (plain paragraph). The form renders these as a numbered
 * list; commands get a copy button + monospace styling, urls become
 * "Open" buttons, and shell snippets stay readable.
 */
export interface SetupStep {
  /** One-line summary of the step ("Enable the Calendar API"). */
  title: string;
  /** Optional body paragraph rendered under the title. Plain text. */
  body?: string;
  /** Optional shell command. Rendered as a code block with a copy button. */
  command?: string;
  /** Optional external URL. Renders an "Open" button next to the title. */
  url?: string;
  /** Optional caption shown next to the URL ("Cloud Console"). */
  urlLabel?: string;
}

export interface CatalogEntry {
  id: string;
  /** Display name (Slack, Linear, Gmail · personal …). */
  name: string;
  description: string;
  /** Names this entry should match against in mcp lists. */
  aliases: string[];
  /**
   * stdio spawn command. Null = info-only entry (e.g. Claude.ai-provided
   * connector, iMessage which currently has no clean MCP).
   */
  command: string | null;
  args: string[];
  /** Env vars to ask the user for. Empty = no config needed. */
  fields: CatalogField[];
  /**
   * Special CWD wrangling (Gmail MCP keeps tokens in CWD). When set,
   * the saved command becomes `sh -c "cd <cwd> && exec <command> <args>"`.
   */
  cwd?: string;
  /** Optional external URL — opens in default browser for upstream setup. */
  setupUrl?: string;
  /** 1-2 sentences of upstream-setup context shown next to the form. */
  setupNotes?: string;
  /**
   * Optional structured walkthrough. When present, the form renders this
   * as a numbered list with copy-pasteable commands + "Open" buttons for
   * URLs. Prefer this over `setupNotes` for anything more than a one-
   * liner — the goal is "user reads top to bottom and is done."
   */
  setupSteps?: SetupStep[];
  /**
   * If true, this entry is provided by claude.ai's hosted connectors and
   * doesn't propagate to Agent SDK subprocess sessions. Surfaced with a
   * warning badge.
   */
  claudeAiOnly?: boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'slack',
    name: 'Slack',
    description: 'Send messages, search users, read channels',
    aliases: ['slack', 'Slack'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    fields: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Bot User OAuth Token',
        placeholder: 'xoxb-…',
        kind: 'secret',
        required: true,
      },
      {
        key: 'SLACK_TEAM_ID',
        label: 'Team ID',
        placeholder: 'T0XXXXX',
        kind: 'text',
        required: true,
        hint: 'Found in any Slack channel URL — the T0XXXXX part.',
      },
    ],
    setupUrl: 'https://api.slack.com/apps?new_app=1',
    setupNotes:
      "Create a Slack app (From scratch), add Bot Token Scopes: chat:write, chat:write.public, im:write, users:read, users:read.email, channels:read, files:write. Install to workspace, then copy the Bot User OAuth Token (xoxb-…).",
  },
  {
    id: 'gmail-personal',
    name: 'Gmail · personal',
    description: 'Send + read email from your personal Gmail account',
    aliases: ['gmail-personal', 'Gmail'],
    command: 'sh',
    args: [
      '-c',
      'cd ~/.jarvis/secrets/google-personal && exec npx -y @gongrzhe/server-gmail-autoauth-mcp',
    ],
    fields: [],
    setupUrl: 'https://console.cloud.google.com',
    setupSteps: GOOGLE_SETUP_STEPS('personal', 'gmail'),
  },
  {
    id: 'gmail-work',
    name: 'Gmail · work',
    description: 'Same flow as personal, scoped to a different Google account',
    aliases: ['gmail-work'],
    command: 'sh',
    args: [
      '-c',
      'cd ~/.jarvis/secrets/google-work && exec npx -y @gongrzhe/server-gmail-autoauth-mcp',
    ],
    fields: [],
    setupUrl: 'https://console.cloud.google.com',
    setupSteps: GOOGLE_SETUP_STEPS('work', 'gmail'),
  },
  {
    id: 'calendar-personal',
    name: 'Calendar · personal',
    description: 'Read + create events on your personal Google Calendar',
    aliases: ['calendar-personal', 'google-calendar-personal'],
    command: 'sh',
    args: [
      '-c',
      'cd ~/.jarvis/secrets/google-personal && exec npx -y @cocal/google-calendar-mcp',
    ],
    fields: [],
    setupUrl: 'https://console.cloud.google.com',
    setupSteps: GOOGLE_SETUP_STEPS('personal', 'calendar'),
  },
  {
    id: 'calendar-work',
    name: 'Calendar · work',
    description: 'Read + create events on your work Google Calendar',
    aliases: ['calendar-work', 'google-calendar-work'],
    command: 'sh',
    args: [
      '-c',
      'cd ~/.jarvis/secrets/google-work && exec npx -y @cocal/google-calendar-mcp',
    ],
    fields: [],
    setupUrl: 'https://console.cloud.google.com',
    setupSteps: GOOGLE_SETUP_STEPS('work', 'calendar'),
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Read + create Linear issues',
    aliases: ['linear', 'Linear'],
    command: 'npx',
    args: ['-y', '@tacticlaunch/mcp-linear'],
    fields: [
      {
        key: 'LINEAR_API_KEY',
        label: 'API Key',
        placeholder: 'lin_api_…',
        kind: 'secret',
        required: true,
        hint: 'Linear → Settings → API → Personal API keys → Create new key.',
      },
    ],
    setupUrl: 'https://linear.app/settings/api',
    setupNotes:
      "Create a personal API key in Linear's settings. The key has access to whatever you do — treat it like a password.",
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search + create + edit Notion pages and databases',
    aliases: ['notion', 'Notion'],
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    fields: [
      {
        key: 'NOTION_API_KEY',
        label: 'Internal Integration Secret',
        placeholder: 'secret_…',
        kind: 'secret',
        required: true,
        hint: 'Create an internal integration in Notion, then share the pages you want it to access.',
      },
    ],
    setupUrl: 'https://www.notion.so/profile/integrations',
    setupNotes:
      'Create an internal integration in Notion → Profile → Integrations. Copy the Internal Integration Secret. Then for each Notion page/database the integration should access, open it and Add connections → your integration.',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: "Search repos / read files / list issues via the gh CLI's existing auth",
    aliases: ['github', 'GitHub'],
    // Reuse `gh auth token` at spawn time so the MCP rides the user's
    // existing `gh auth login` — no separate PAT needed, and the token
    // refreshes whenever they re-run gh auth. Falls back to whatever the
    // user has in GITHUB_PERSONAL_ACCESS_TOKEN if `gh` isn't installed.
    command: 'sh',
    args: [
      '-c',
      'GITHUB_PERSONAL_ACCESS_TOKEN="$(gh auth token 2>/dev/null || echo "${GITHUB_PERSONAL_ACCESS_TOKEN:-}")" exec npx -y @modelcontextprotocol/server-github',
    ],
    fields: [],
    setupUrl: 'https://cli.github.com/',
    setupNotes:
      "Uses your existing gh CLI auth — run `gh auth login` in a terminal first if you haven't. No PAT needed. Note: for PR review / commit / branch workflows you probably don't need this MCP at all — the agent's Bash tool can call `gh` directly. This MCP shines for richer programmatic access (search across repos, raw API, file contents).",
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write files under a chosen directory',
    aliases: ['filesystem'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~'],
    fields: [],
    setupNotes:
      'Exposes your home directory to the agent. For tighter scope, edit the entry in mcp.json afterwards and replace `~` with a specific folder path.',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read and inspect Figma files',
    aliases: ['figma', 'Figma'],
    command: null,
    args: [],
    fields: [],
    claudeAiOnly: true,
    setupUrl: 'https://claude.ai/settings/connectors',
    setupNotes:
      "Figma's MCP is available via Claude.ai's hosted connectors only. Heads up: claude.ai connectors don't currently propagate to Jarvis tasks. If you need Figma in /send-style workflows, watch this space — we'll add a local-MCP path when Figma ships one.",
  },
  {
    id: 'imessage',
    name: 'iMessage',
    description: 'Read + send iMessage from macOS',
    aliases: ['imessage'],
    command: null,
    args: [],
    fields: [],
    setupNotes:
      "Requires a community iMessage MCP (search 'modelcontextprotocol imessage' on GitHub) and Full Disk Access granted to the MCP process. Add manually via 'Custom MCP' once you have a server installed.",
  },
];

/**
 * Step-by-step walkthrough for any Google service on any account. Shared
 * between Gmail + Calendar entries because the Cloud Console dance is
 * identical — the only thing that varies is the API to enable and the
 * scopes to add. The skill body covers both Gmail + Calendar use cases
 * with one set of credentials.
 */
function GOOGLE_SETUP_STEPS(
  identity: 'personal' | 'work',
  service: 'gmail' | 'calendar',
): SetupStep[] {
  const dir = `~/.jarvis/secrets/google-${identity}`;
  const apiToEnable =
    service === 'gmail' ? 'Gmail API' : 'Google Calendar API';
  const scopes =
    service === 'gmail'
      ? ['https://mail.google.com/']
      : [
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/calendar.readonly',
        ];
  const mcpPkg =
    service === 'gmail'
      ? '@gongrzhe/server-gmail-autoauth-mcp'
      : '@cocal/google-calendar-mcp';
  const identityNote =
    identity === 'work'
      ? 'Your work Google Workspace admin may need to approve unverified OAuth apps. If the consent screen rejects you, ping IT.'
      : 'Personal Google account — you have full control, no IT approval needed.';

  return [
    {
      title: `Create or open the Google Cloud project for this ${identity} account`,
      body: `One OAuth app per account covers both Gmail + Calendar (and future Google services). If you already set up Gmail · ${identity}, you can reuse the same app — just enable a new API and add scopes below. ${identityNote}`,
      url: 'https://console.cloud.google.com',
      urlLabel: 'Cloud Console',
    },
    {
      title: `Enable the ${apiToEnable}`,
      body: 'APIs & Services → Library → search by name → Enable. Each API is per-project, not per-app.',
    },
    {
      title: 'Add the scopes to your OAuth consent screen',
      body: `APIs & Services → OAuth consent screen → Edit App → Scopes → Add or Remove Scopes. Paste each URL below into the filter, check it, save.`,
      command: scopes.join('\n'),
    },
    {
      title: `Place the OAuth credentials file at ${dir}/gcp-oauth.keys.json`,
      body: 'Download the OAuth client JSON from Credentials → your OAuth 2.0 Client → ⤓ Download JSON. Move it into the directory below (Jarvis keeps all Google secrets here — one folder per identity).',
      command: `mkdir -p ${dir} && mv ~/Downloads/client_secret_*.json ${dir}/gcp-oauth.keys.json`,
    },
    {
      title: 'Authenticate the MCP',
      body: `Runs the OAuth flow in your browser and writes the refresh token to ${dir}/credentials.json. You only do this once per (service, account).`,
      command: `cd ${dir} && npx -y ${mcpPkg} auth`,
    },
    {
      title: 'Register the MCP in Jarvis',
      body: 'Click Save below. Jarvis adds an entry to ~/.jarvis/mcp.json that points at the directory you just authenticated. The MCP starts on next task launch — verify with `claude mcp list` or by typing a query that uses the tool.',
    },
  ];
}
