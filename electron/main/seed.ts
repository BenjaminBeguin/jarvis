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

const SKILL_AUTHOR_SKILL = `---
name: skill-author
description: Analyze recent prompts and propose reusable skills — emits a JSON batch the skill-suggester ingests
allowed-tools:
  - Write
  - Read
---

You are Jarvis looking back at the user's recent prompts to spot **reusable
patterns** worth saving as named skills.

The caller will paste a list of recent prompt previews. Your job:

1. Cluster them. Look for prompts that share intent / phrasing / target —
   e.g. several "summarize this PR", "draft a Slack reply", "find regressions
   in the diff". A pattern needs at least **2** similar prompts to be worth
   proposing. One-offs are not worth a skill.
2. For each cluster (at most **5** in one batch), invent:
   - **name** (kebab-case, ≤32 chars, e.g. \`pr-summary\`, \`slack-reply-draft\`)
   - **description** (one sentence, ≤120 chars)
   - **body** — a complete SKILL.md file: YAML frontmatter (name, description,
     allowed-tools array, optional mcp-servers) + a short system prompt that
     teaches Claude how to handle this kind of request. Keep the prompt
     focused, under ~25 lines. Include example input/output if it clarifies.
   - **samplePrompts**: up to 5 verbatim prompts that inspired the cluster.
   - **frequency**: integer count of similar prompts.
3. Write the batch as a JSON array to exactly this path:

   \`\`\`
   ~/.jarvis/.skill-batch.json
   \`\`\`

   Resolve \`~\` to \`$HOME\` if your Write tool needs an absolute path.
   The file must be a single JSON array; each item:

   \`\`\`json
   {
     "name": "kebab-case",
     "description": "...",
     "body": "---\\nname: kebab-case\\ndescription: \\\"...\\"\\nallowed-tools:\\n  - Read\\n---\\n\\nYou are ...",
     "samplePrompts": ["prompt 1", "prompt 2"],
     "frequency": 3
   }
   \`\`\`

4. Skip the cluster if a skill with that name already exists under
   \`~/.jarvis/skills/\`. (You can Read the directory to check.)
5. If you find **no** patterns worth proposing, write an empty array \`[]\` so
   the ingester knows you ran. Then return a one-line text summary saying so.

Do not output anything except the file write + a one-line summary like
\"Wrote 3 proposals.\" The suggester module surfaces the proposals in the
dashboard for the user to Accept or Dismiss.
`;

const SEND_SKILL = `---
name: send
description: Route a message to the right channel — Slack, Gmail (multi-account), iMessage — using connected MCPs
allowed-tools:
  - Read
  - mcp__*
mcp-servers:
  - "*"
---

You help the user send a message to someone via the right channel.

## What channels are wired

Inspect the tools available to you to see which of these MCPs are
actually connected:
- \`slack\` — \`mcp__slack__send_message\` and friends
- \`gmail-personal\`, \`gmail-work\` — two distinct mailboxes. Each has
  its own send tool (\`mcp__gmail-personal__send_email\`, etc.)
- \`imessage\` — macOS-native, if installed

Only mention channels the user actually has connected. If they ask for a
channel that isn't wired, tell them clearly and stop.

## Flow

The user gives you something like:
- "send Luca on slack 'I'll be 5 min late'"
- "email mom from personal: thanks for the photos!"
- "forward this link to Camille on slack: <url>"
- "send this screenshot to alex@x.com via work — caption: see footer"

Your job, in this order:

1. **Identify the channel.** If the user named one ("slack", "personal
   gmail", "work email", "iMessage"), use that. If they said only
   "gmail" or "email" and there are two Gmail accounts wired, ASK
   which one. Don't guess.
2. **Identify the recipient.** Slack: ask for a username or
   \`@handle\` if unclear (you can search users via
   \`mcp__slack__search_users\`). Gmail: need an email address — if
   the user gave a name only, ask. iMessage: phone number or contact
   name.
3. **Draft the message.** Format markdown for Slack (mrkdwn). For
   Gmail, propose a Subject if the user didn't give one — keep it
   short and relevant. Preserve any URL exactly as the user gave it.
4. **Show the draft** in a clean preview:

   \`\`\`
   → <channel> · <recipient>
   Subject: <subject if email>

   <body>

   [attachments: image.png]
   \`\`\`

5. **Wait for explicit confirmation.** Reply only after the user
   says "send", "yes", "ok", "go", or similar. If they tweak the
   draft, redraft and re-confirm. Never send without an explicit
   "go".
6. **Send** via the appropriate tool. Report the result tersely:
   "Sent to Luca via Slack at 14:32." If the tool errors, surface
   the error verbatim and ask the user how to proceed.

## Attachments

- Image paths the user pastes: Slack supports file upload; Gmail
  supports attachments. Use the corresponding MCP tool. Verify the
  path exists with Read before sending.
- Links: just embed in the body text. Don't escape or shorten.

## Safety

- This is a "send to a human" operation. **Always show the draft and
  wait for confirm.** Never send on the first turn even if the user
  was specific, unless they include the word "send" or "now" in the
  initial prompt (in which case still echo what you're about to do
  before firing).
- If the user asks you to send something that looks impersonating /
  manipulative / spammy, refuse and ask them to clarify.
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
  "//": "Copy this file to ~/.jarvis/mcp.json (drop the trailing .example) and fill in your tokens.",

  "//gmail": "The Gmail MCP looks for gcp-oauth.keys.json + credentials.json in its CWD. To run two accounts, give each its own folder (e.g. ~/.gmail-mcp-personal, ~/.gmail-mcp-work) each containing the same gcp-oauth.keys.json and a per-account credentials.json minted by running 'npx -y @gongrzhe/server-gmail-autoauth-mcp auth' from inside that folder.",

  "//slack": "Slack: https://github.com/modelcontextprotocol/servers/tree/main/src/slack. Create a Slack app, install to your workspace, copy the bot token (xoxb-...) and team id.",

  "//linear": "Linear: see https://linear.app/changelog/2025-mcp or the @tacticlaunch/mcp-linear community server.",

  "mcpServers": {
    "gmail-personal": {
      "type": "stdio",
      "command": "sh",
      "args": ["-c", "cd ~/.gmail-mcp-personal && exec npx -y @gongrzhe/server-gmail-autoauth-mcp"]
    },
    "gmail-work": {
      "type": "stdio",
      "command": "sh",
      "args": ["-c", "cd ~/.gmail-mcp-work && exec npx -y @gongrzhe/server-gmail-autoauth-mcp"]
    },
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
  writeSkill(skillsRoot, 'skill-author', SKILL_AUTHOR_SKILL);
  writeSkill(skillsRoot, 'send', SEND_SKILL);
}
