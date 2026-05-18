/**
 * Sample config files seeded next to `~/.jarvis/`. These are the .example
 * variants — the user copies them, strips `.example`, and edits.
 */

export const SAMPLE_MCP_CONFIG = `{
  "//": "Define custom MCP servers globally; skills opt-in via mcp-servers: [name] in their frontmatter, or 'mcp-servers: [\\"*\\"]' to inherit everything here. Copy this file to ~/.jarvis/mcp.json (drop the .example) and fill in any tokens.",

  "//note": "For Slack, Google (Gmail + Calendar), Notion, and Linear, use Settings → Integrations → Connected accounts instead — those run OAuth, store tokens in Keychain, and publish managed MCP entries automatically.",

  "//custom": "This file is for everything else: filesystem access, custom or in-house MCPs, etc.",

  "mcpServers": {
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
