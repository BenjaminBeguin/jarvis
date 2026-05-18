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
  /**
   * Optional config file under ~/.jarvis/ that this integration reads.
   * Renders an "Edit" button that opens an inline markdown editor. Used
   * by skills that need user-controlled scope (e.g. Slack watchlist:
   * which channels / DMs to scan).
   */
  configFile?: {
    /** Path relative to ~/.jarvis/ (e.g. "slack-watchlist.md"). */
    path: string;
    /** Button label ("Edit watchlist", "Edit team"). */
    label: string;
    /** Optional one-liner shown in the modal header. */
    description?: string;
  };
  /**
   * Inbox JSON files this integration's skills populate (relative to
   * `~/.jarvis/inbox/`). When the user disables or removes the
   * integration, the Integrations UI shows how many items will go
   * stale, and the Remove flow offers to clear these files.
   */
  inboxFiles?: string[];
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
    configFile: {
      path: 'slack-watchlist.md',
      label: 'Edit watchlist',
      description:
        'Channels, DMs, and people the slack-pulse / daily-recap skills scan. Markdown; edit freely.',
    },
    inboxFiles: ['slack-pulse.json'],
  },
  // Gmail · personal / Gmail · work / Calendar · personal / Calendar · work
  // used to live here — each one a separate stdio MCP wrapping
  // @gongrzhe/server-gmail-autoauth-mcp or @cocal/google-calendar-mcp with
  // per-account OAuth files under ~/.jarvis/secrets/. They've been
  // retired in favour of the unified Google connector (Connected
  // accounts → Google → Add account), which covers Gmail + Calendar
  // in one OAuth grant per account with tokens in Keychain. The
  // migration in electron/main/index.ts strips the legacy entries
  // from ~/.jarvis/mcp.json on first launch.
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
