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

/**
 * Triage policy seeded at `~/.jarvis/triage-policy.md`. Read by every
 * channel-specific triage skill (gmail-triage today, slack-triage and
 * others later) at the start of each run. Drives what gets archived,
 * what gets drafted, what gets ignored, and what tone to write in.
 *
 * Single file across channels (sub-section per channel). The
 * `## People` and `## Defaults` sections apply globally so an "always
 * draft for X" rule works whether X emails or DMs.
 *
 * Plain markdown. Edit freely. Save and the next workflow tick picks
 * up the new rules.
 */
export const SAMPLE_TRIAGE_POLICY = `# Triage policy

Channel-specific triage skills (gmail-triage, slack-triage, …) read
this file every run. Edit freely — the next tick picks up changes.

## People I want to hear from

People I always want a draft reply for, no matter the channel. Names,
email addresses, slack handles — whatever matches.

- (e.g. "alice@acme.com — boss, always draft")
- (e.g. "@bob — direct report, treat seriously")

## Senders to archive

Domains and patterns that should NEVER get a draft — newsletters,
marketing, automated mail. Listed here, the triage skill recommends
archive (or auto-archives in Phase B).

- noreply@*
- no-reply@*
- newsletter@*
- marketing@*
- *@notifications.atlassian.com
- (add your own patterns)

## Topics to take seriously

Subject/body keywords that should always produce a draft, even from
unknown senders.

- interview
- offer
- contract
- intro / introduction
- urgent / asap

## Topics to ignore

Subject/body patterns that should be dropped entirely (no draft, no
surface). The skill omits them from the output.

- receipt
- order confirmation
- password reset
- (GitHub / Linear / Slack notifications are already handled by
  dedicated workflows — let those flows surface them)

## Tone & signature

How drafts should be written. The skill applies this as the default;
override per-recipient under "People I want to hear from" if needed.

- Tone: peer-to-peer, 1-3 sentences. No greeting, no signoff.
- Signature: (paste your standard sign-off block, or leave blank)

## My availability

Free-text. The skill paraphrases this when a message asks about
scheduling. In Phase B+ this will be replaced by a live calendar
lookup.

- Working hours: 9:00–18:00 Mon–Fri (local time)
- Best for short syncs: Tue 2–4pm, Wed mornings
- Long blocks: Friday afternoons

## Gmail

(Optional channel-specific overrides — leave blank to use the
defaults above.)

## Slack

(Same — channel-specific overrides go here.)

## Running notes

Calibration appends timestamped entries here.
`;

/**
 * Initial calibration file for the tech-watch loop. Lives at
 * `~/.jarvis/tech-watch.md`. The `tech-watch` skill reads it on each
 * fire (8 AM weekdays) to pull RSS feeds, run a topic-grounded
 * WebSearch fallback, and summarise newsletters from the listed
 * Gmail senders. `/tech-watch-calibrate` walks the user through
 * filling it in.
 *
 * Same `(e.g. "...")` placeholder convention as inbox-priorities.md —
 * the Inbox nudge substring-matches one of these to know the file
 * hasn't been customised yet.
 */
/**
 * Calibration for the work-awareness loop. Lives at
 * `~/.jarvis/work-awareness-priorities.md`. The `work-awareness`
 * skill reads it every 30 min and uses it to decide what to
 * surface vs mute when scanning recent activity across Slack /
 * GitHub / Linear / Notion / meetings / notes.
 *
 * Plain markdown — no required sections; the headings below are
 * suggestions. Re-fire `/work-awareness-calibrate` (a future
 * conversational refiner, same shape as `/inbox-calibrate`) to
 * teach the file over time.
 */
export const SAMPLE_WORK_AWARENESS_PRIORITIES = `# Work awareness — priorities

The work-awareness loop reads this every 30 min during your working
hours and uses it to decide what counts as a "loop worth flagging"
vs background noise. Edit freely; the next tick picks up changes.

## What kinds of signals to surface

- (e.g. "Slack threads where someone asked me a question and I haven't replied")
- (e.g. "PRs I opened that have new comments since my last push")
- (e.g. "Meeting action items where I'm the owner and the deadline is today/tomorrow")
- (e.g. "Notion pages I opened today that have unresolved comments tagged to me")

## People whose threads / mentions matter

- (e.g. "Theo — anything from him jumps straight in")
- (e.g. "My team's #squad-foo channel — surface mentions even off-hours")

## What to consider "done" (auto-dismiss)

- (e.g. "PR I merged today — drop any related review-it inbox items")
- (e.g. "Slack message I sent in the past 2h to <person> — drop any 'reply to <person>' inbox items")
- (e.g. "Meeting action item where I see a matching activity entry / file change today")

## What to mute

- (e.g. "Slack #random, #announcements, #memes")
- (e.g. "PR comments that are just 'lgtm' / 'thanks' / approving emoji reactions")
- (e.g. "Notion comments resolved in the same day")
- (e.g. "Tickets older than 2 weeks with no recent activity")

## What 'urgent' looks like for me

- (e.g. "Someone explicitly blocking on me")
- (e.g. "Today's meetings where I owe prep / a draft beforehand")
- (e.g. "Action items with a deadline today")

## Running notes

- (Calibration appends timestamped entries here.)
`;

export const SAMPLE_TECH_WATCH = `# Tech watch

The tech-watch loop reads this file once a day (8 AM weekdays) and
writes a ranked digest to your Inbox under "Tech watch · industry".
Edit freely. Run \`/tech-watch-calibrate\` for a guided setup.

## Topics

What's your industry / what should I be watching? Free text bullets.
Used to score RSS items and (when feeds are thin) to drive a
WebSearch fallback.

- (e.g. "AI infra: LLMs, embeddings, vector DBs, inference cost")
- (e.g. "Productivity software, project management, async work")

## RSS feeds

URLs, one per line. Anything Atom or RSS is fine. Examples below —
delete and replace with your own. Keep this list short: 5–10 feeds is
enough to fill the daily digest without bloat.

- (e.g. "https://news.ycombinator.com/rss")
- (e.g. "https://stratechery.com/feed/")

## Newsletter senders

Gmail \`from:\` patterns — exact addresses or domains. Only senders
listed here get checked; nothing else from your inbox is touched.

- (e.g. "from:newsletter@stratechery.com")
- (e.g. "from:noreply@substack.com")

## Mute

Terms in title or body that should drop an item from the digest.

- (e.g. "crypto, NFT, web3")
- (e.g. "show HN")

## Running notes

(Calibration appends timestamped entries here.)
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
