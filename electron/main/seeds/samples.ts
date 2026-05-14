/**
 * Sample config files seeded next to `~/.jarvis/`. These are the .example
 * variants — the user copies them, strips `.example`, and edits.
 */

export const SAMPLE_MCP_CONFIG = `{
  "//": "Define MCP servers globally; skills opt-in via mcp-servers: [name] in their frontmatter, or 'mcp-servers: [\\"*\\"]' to inherit everything here. Copy this file to ~/.jarvis/mcp.json (drop the .example) and fill in tokens.",

  "//slack": "Slack: create a Slack app at https://api.slack.com/apps, install to your workspace, copy the Bot User OAuth Token (xoxb-...) and Team ID. The claude.ai Slack connector does NOT propagate to Jarvis tasks — you need this local entry to use /send.",

  "//gmail": "Two options. (A) Easiest: install via 'claude mcp add gmail-personal --scope user -- sh -c \\"cd ~/.gmail-mcp-personal && exec npx -y @gongrzhe/server-gmail-autoauth-mcp\\"' after running the GongRzhe auth flow once. (B) Or pin it here under mcpServers with the same sh-c command — same effect, scoped to Jarvis only.",

  "//linear": "Linear: see https://linear.app/changelog/2025-mcp or the @tacticlaunch/mcp-linear community server.",

  "mcpServers": {
    "slack": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_TEAM_ID": "T0000..."
      }
    },
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~"]
    }
  }
}
`;

export const SAMPLE_PROJECTS = `{
  "//": "Tell Jarvis about your projects so it can resolve 'the X project' or 'PR 340 on cs ai'. Aliases are case-insensitive substrings; the agent uses them when you reference a project by nickname.",
  "projects": [
    {
      "name": "Example",
      "aliases": ["example", "ex"],
      "path": "~/Code/example",
      "repo": "github.com/yourorg/example",
      "description": "what this project is"
    }
  ]
}
`;
