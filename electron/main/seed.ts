import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

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

const MEETING_DEBRIEF_SKILL = `---
name: meeting-debrief
description: Post-meeting structuring — reads a transcript markdown file and rewrites it with Summary / Decisions / Action items / Open questions sections
allowed-tools:
  - Read
  - Write
  - Edit
---

You are Jarvis structuring a freshly recorded meeting.

The user will give you the path to a markdown file under ~/.jarvis/meetings/.
The file has YAML frontmatter (title, started_at, duration_seconds) followed
by a raw Whisper transcript. Your job:

1. **Read** the file at the given path.
2. **Edit** it in place: keep the existing frontmatter and the original
   transcript exactly as-is (under a new "## Transcript" heading at the
   bottom). Insert the following sections BEFORE the transcript:

   - **## Summary** — 2-4 sentences. What was this meeting about? What was
     accomplished?
   - **## Key decisions** — bullets. If nothing was decided, say so explicitly
     ("No firm decisions.").
   - **## Action items** — bullets shaped \`[owner] action — by when\`. If no
     owner was named, write \`[?]\`. If no deadline was set, omit "— by when".
     If there are no action items, say "No action items."
   - **## Open questions** — bullets of unresolved points worth following up.
   - **## Topics** — short comma-separated tags.

3. Use exactly these headings and order. Don't add a preface, don't add a
   closing comment. Don't quote large chunks from the transcript — paraphrase.
4. If the transcript is empty or just noise ("_no speech detected_", "thank
   you", etc.), insert a single line under Summary noting that and leave the
   other sections with "—".

Do not invent attendees, decisions, or action items. If something isn't in
the transcript, don't put it in the structured sections.
`;

const STATUS_SKILL = `---
name: status
description: "What is happening right now — read tasks/reminders/notes/meetings under ~/.jarvis and produce a tight status digest"
allowed-tools:
  - Read
  - Bash
  - Glob
---

You are Jarvis producing a 'where am I' status report for the user.

Look under \`~/.jarvis/\` for:
- \`reminders.json\` — pending reminders (status: pending) and their fire times
- \`notes/*.md\` — most recent 2-3 entries
- \`meetings/*.md\` — most recent 1-2 files, pull their Summary if structured
- \`jarvis.sqlite\` — skip; not useful in raw form

Also run \`gh pr status\` if available (one-line per PR).

Produce a markdown digest with these sections (skip a section if empty):

## ⏰ Scheduled
- One line per pending reminder/scheduled action, sorted by fire time.

## ✎ Recent notes
- Last 3 note entries, time + first 80 chars.

## 🎙 Last meetings
- Title + summary line.

## 🐙 GitHub
- gh pr status output, condensed.

End with one sentence: 'Recommended next move: …'. Be specific. Keep the
whole digest under 30 lines.
`;

const COMMIT_HELPER_SKILL = `---
name: commit-helper
description: Drafts a short commit message for the current working tree diff
allowed-tools:
  - Bash
---

You are drafting a commit message for the user.

1. Run \`git status\` and \`git diff --cached\` (or \`git diff\` if nothing staged) to see the changes.
2. Read the most recent ~5 commit messages with \`git log --oneline -5\` so the style matches.
3. Return ONLY the proposed commit message — first line under 70 chars, optional body explaining the why, separated by a blank line. No preamble, no closing comment.

If there's nothing to commit, say so in one line.
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

const SAMPLE_PROJECTS = `{
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

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content, 'utf8');
}

function writeSkill(skillsRoot: string, name: string, body: string): void {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  if (!existsSync(path)) {
    writeFileSync(path, body, 'utf8');
    return;
  }
  // Self-heal: if the on-disk file has unparseable YAML frontmatter (almost
  // always a bug in a prior seed string, not an intentional user edit —
  // a broken SKILL.md is useless to the runner either way), overwrite with
  // the current known-good body. Catches earlier shipped versions of seeds
  // that had quote-mismatched descriptions, etc.
  try {
    matter(readFileSync(path, 'utf8'));
  } catch {
    writeFileSync(path, body, 'utf8');
  }
}

export function seedDefaultsIfEmpty(): void {
  const root = join(homedir(), '.jarvis');
  const skillsRoot = join(root, 'skills');
  mkdirSync(skillsRoot, { recursive: true });

  writeIfMissing(join(root, 'mcp.json.example'), SAMPLE_MCP_CONFIG);
  writeIfMissing(join(root, 'projects.json.example'), SAMPLE_PROJECTS);

  // Each built-in skill seeds only if missing. New built-ins added in later
  // versions show up automatically; user-authored skills are never touched.
  // (To customize a built-in, edit the SKILL.md — we won't overwrite it.)
  writeSkill(skillsRoot, 'brainstorm', BRAINSTORM_SKILL);
  writeSkill(skillsRoot, 'daily-brief', DAILY_BRIEF_SKILL);
  writeSkill(skillsRoot, 'meeting-debrief', MEETING_DEBRIEF_SKILL);
  writeSkill(skillsRoot, 'status', STATUS_SKILL);
  writeSkill(skillsRoot, 'commit-helper', COMMIT_HELPER_SKILL);
}
