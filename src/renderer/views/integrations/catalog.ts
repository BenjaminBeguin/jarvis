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
      'cd ~/.gmail-mcp-personal && exec npx -y @gongrzhe/server-gmail-autoauth-mcp',
    ],
    fields: [],
    setupUrl: 'https://console.cloud.google.com',
    setupNotes:
      "Run upstream setup once: mkdir ~/.gmail-mcp-personal, drop your gcp-oauth.keys.json there, then `cd ~/.gmail-mcp-personal && npx -y @gongrzhe/server-gmail-autoauth-mcp auth`. Click Save below to register the entry — your refresh token is already in the folder.",
  },
  {
    id: 'gmail-work',
    name: 'Gmail · work',
    description: 'Same flow as personal, with a different folder',
    aliases: ['gmail-work'],
    command: 'sh',
    args: [
      '-c',
      'cd ~/.gmail-mcp-work && exec npx -y @gongrzhe/server-gmail-autoauth-mcp',
    ],
    fields: [],
    setupNotes:
      "Run the auth flow inside ~/.gmail-mcp-work, logging in with your work Gmail. Note: Google Workspace admins often block unverified OAuth apps; ask your IT to approve your client first.",
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
    description: 'Read PRs / issues / files via the official server',
    aliases: ['github', 'GitHub'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    fields: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal Access Token',
        placeholder: 'ghp_… or github_pat_…',
        kind: 'secret',
        required: true,
        hint: 'Classic or fine-grained PAT — scope it to the repos you want to read.',
      },
    ],
    setupUrl: 'https://github.com/settings/tokens',
    setupNotes:
      'Create a token at github.com/settings/tokens. For PR review workflows the gh CLI is usually enough — this is for richer programmatic access (search, file contents, etc).',
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
