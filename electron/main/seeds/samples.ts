/**
 * Sample config files seeded next to `~/.jarvis/`. These are the .example
 * variants — the user copies them, strips `.example`, and edits.
 */

/**
 * Initial calibration file for the smart inbox. Lives at
 * `~/.jarvis/inbox-priorities.md`. The `inbox-curate` skill reads it
 * every refresh to decide which raw items get hoisted into the Smart
 * section. The `/inbox-calibrate` skill (run weekly) appends to it
 * based on what was useful in the last week.
 *
 * Plain markdown. No required sections; the headings below are
 * suggestions the curator looks for but won't fail without.
 */
export const SAMPLE_INBOX_PRIORITIES = `# Inbox priorities

The smart inbox uses this file to decide which items bubble up.
Edit freely — there's no required shape. Run \`/inbox-calibrate\`
once a week to refine these based on what was actually useful.

## People who matter

- (e.g. "Manager — anything from them is top priority")
- (e.g. "Direct reports — surface their PRs + DMs above everything else")

## Projects that matter right now

- (e.g. "ship-q4 — anything blocking this lands at the top")
- (e.g. "core-infra — only urgent stuff; routine tickets can sink")

## Topics / keywords to bubble up

- (e.g. "production incident, on-call, paging")
- (e.g. "interview, hiring loop")

## Things to mute

- (e.g. "Slack #random, #memes, #announcements")
- (e.g. "Linear: tickets older than 2 weeks with no recent activity")
- (e.g. "PR comments that are just 'lgtm' or 'thanks'")

## What 'urgent' looks like for me

- (e.g. "Anyone asking for a decision I can make in <5 min")
- (e.g. "Something due today or tomorrow")
- (e.g. "A blocker someone is explicitly waiting on")

## Running notes

- (Calibration appends timestamped entries here.)
`;

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
