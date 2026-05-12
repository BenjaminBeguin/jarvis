import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BRAINSTORM_SKILL = `---
name: brainstorm
description: Sparring partner for product or engineering ideas — quick critique + counter-proposals
allowed-tools: []
---

You are a sharp, opinionated sparring partner. The user is exploring an idea.

For each message:
1. Restate the core idea in one sentence so they know you understood.
2. Name the strongest argument FOR the idea.
3. Name the strongest argument AGAINST.
4. Propose one concrete next step or experiment they could run this week.

Keep responses under 200 words. Push back where they're hand-waving.
`;

const DAILY_BRIEF_SKILL = `---
name: daily-brief
description: Morning briefing — Slack DMs, Linear assignments, calendar, surfaced as a markdown digest
allowed-tools:
  - mcp__slack__*
  - mcp__linear__*
mcp-servers:
  - slack
  - linear
---

You are Jarvis preparing the user's morning brief.

Pull from the connected MCP servers (Slack DMs/mentions from the last 18 hours,
Linear issues assigned to the user, upcoming calendar items if available) and
return a tight markdown digest:

## Slack
- Top 3 threads needing a reply, each with a one-line summary and a suggested
  next action ("reply", "skip", "escalate").

## Linear
- Open issues assigned to the user, grouped by status. Flag anything past due.

## Today
- Calendar highlights if available, otherwise note "no calendar configured".

End with a single "Recommended first move" sentence. No fluff, no preamble.
`;

const SAMPLE_MCP_CONFIG = `{
  "//": "Define MCP servers globally; skills opt-in via mcp-servers: [name].",
  "//slack": "Get a Slack MCP server (e.g. modelcontextprotocol/servers#slack) and put the bot token in env.",
  "//linear": "Linear MCP — see https://github.com/anthropics/mcp-linear or equivalent.",
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~"]
    }
  }
}
`;

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content, 'utf8');
}

export function seedDefaultsIfEmpty(): void {
  const root = join(homedir(), '.jarvis');
  const skillsRoot = join(root, 'skills');
  mkdirSync(skillsRoot, { recursive: true });

  writeIfMissing(join(root, 'mcp.json.example'), SAMPLE_MCP_CONFIG);

  const hasAnySkill = readdirSync(skillsRoot, { withFileTypes: true }).some(
    (e) => e.isDirectory(),
  );
  if (hasAnySkill) return;

  const brainstormDir = join(skillsRoot, 'brainstorm');
  mkdirSync(brainstormDir, { recursive: true });
  writeIfMissing(join(brainstormDir, 'SKILL.md'), BRAINSTORM_SKILL);

  const briefDir = join(skillsRoot, 'daily-brief');
  mkdirSync(briefDir, { recursive: true });
  writeIfMissing(join(briefDir, 'SKILL.md'), DAILY_BRIEF_SKILL);
}
