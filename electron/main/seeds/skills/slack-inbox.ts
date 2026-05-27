export default `---
name: slack-inbox
description: Scan Slack for threads the user actually MISSED — not conversations they were in. Quiet by default — only surface items genuinely waiting on the user.
allowed-tools:
  - Read
  - Write
  - mcp__*
mcp-servers:
  - slack
---

You scan the user's Slack workspace for **things they actually
missed** — not chats they were participating in.

The Inbox tab will pick up your output on its next 5-minute refresh.
Don't loop / poll — produce one pass of items and exit.

## Strict definition of "waiting on me"

A thread qualifies ONLY when ALL of these are true:

1. The latest message is from someone else (not the user).
2. The user has NOT replied in this thread within the last 6 hours.
   (If they replied recently, they're aware — drop it.)
3. The latest message is NOT a closure signal (see filter list below).
4. The latest message either:
   - Mentions the user by name / @-handle, OR
   - Is in a DM, OR
   - Asks an explicit question (ends with "?", contains "can you",
     "could you", "what about", "thoughts?", "any update", etc.)

If you can't confirm ALL FOUR, do NOT include the thread. False
positives are the main failure mode here — when in doubt, drop it.

## Closure-signal filter (drop these immediately)

Skip any thread where the latest message is:

- **Acknowledgements**: "thanks", "thank you", "thx", "ty", "cool",
  "great", "perfect", "awesome", "nice", "good", "got it", "gotcha",
  "ok", "okay", "k", "sounds good", "makes sense", "noted", "ack",
  "+1", "yes", "yep", "yup", "sure", "right", "exactly", "agreed",
  "lgtm", "ship it"
- **Emoji-only** messages (just ":thumbsup:", ":fire:", any single
  emoji or short emoji string with no real words)
- **Bot messages** (any sender ending in "-bot", "github", "linear",
  "datadog", "pagerduty", or with \`bot_id\` set)
- **Reactions** (the API surfaces these as messages but they're not
  conversation)
- **Auto-confirmations** ("opened PR", "deployed", "merged", "build
  passed", "added to canvas")
- **Closing pleasantries**: "have a good one", "ttyl", "speak soon",
  "talk to you tomorrow", "happy friday"
- **Self-resolution by sender**: "actually nevermind, figured it
  out", "ignore my last", "resolved", "fixed it myself"

Be liberal with this filter. If a thread title would make the user
think "why is this in my inbox", drop it.

## What to also exclude

- Their own messages.
- Channels they're a member of but rarely engage with — heuristic:
  the user hasn't sent in there in 30+ days → not a priority channel.
- Threads where the user replied 6h+ ago AND no one asked a new
  question after their reply. The conversation moved on without them.
- Mentions of the user as a third-party reference ("ask Ben about
  X" vs "Ben, can you do X?"). Only the second case is waiting.
- Channel announcements / broadcasts (\`<!channel>\`, \`<!here>\`)
  unless the user is specifically addressed afterward.

## Process

1. **Discover the workspace.** Use \`mcp__slack__*\` tools. If the
   Slack MCP isn't connected, write an empty array to the output file
   (see below) and stop. Don't error.

2. **Pull recent DMs** — last ~48 hours. For each thread:
   - Read the last 10 messages
   - Apply the strict definition above
   - Apply the closure-signal filter
   - Only include if it survives both

3. **Pull @-mentions** — last ~24 hours. Same filtering. Critically:
   if the user has replied AFTER the mention, drop it unless the
   sender came back with a NEW question.

4. **Triage to inbox items**, one per surviving thread:

   \`\`\`json
   {
     "id": "slack-<channel-id>-<thread-ts>",
     "title": "<sender>: <first 80 chars of latest message>",
     "subtitle": "<channel name> · <human-friendly age> · <why>",
     "url": "<slack permalink>",
     "createdAt": <ms epoch of the latest message>,
     "why": "<one-line reason this qualifies, e.g. 'DM, no reply in 18h' or 'mentioned + asked question, no reply'>",
     "action": {
       "label": "Draft reply",
       "skillId": "send",
       "prompt": "Draft a Slack reply to <sender> in <#channel>: <context>"
     }
   }
   \`\`\`

   The \`id\` must be stable across runs so the Inbox can dedupe — use
   \`slack-<channel-id>-<thread-ts>\` exactly.

   Include \`why\` — the user reads this to verify your filter
   worked. If the why reads as obvious noise ("acknowledgement after
   user's reply"), the item shouldn't have made it through; drop it.

5. **Write the output** to exactly this path:

   \`\`\`
   ~/.jarvis/inbox/slack.json
   \`\`\`

   As a wrapper object:

   \`\`\`json
   {
     "source": "slack",
     "label": "Slack waiting on you",
     "items": [ ... ]
   }
   \`\`\`

   Overwrite the file on every run (don't append). Empty items array
   is valid — clears the section in the Inbox. **A clean inbox is a
   correct outcome, not a failure.**

6. **One-line confirmation** to the user: e.g. "2 Slack threads
   waiting (1 DM, 1 mention) — filtered 14 closures" or "Slack
   inbox clean — filtered 9 closures." The "filtered N" count
   tells the user the skill is doing its job.

## Hard rules

- **Bias toward fewer items.** A clean inbox with 1 real signal beats
  a cluttered one with 9 noise items hiding 1 real one. When in
  doubt, drop.
- **Never send a message** — you only produce inbox items. The user
  clicks Draft reply (which fires \`/send\`) to actually respond.
- **Don't include channel content** the user shouldn't see again as
  a notification body — keep titles to the first 80 chars, never
  paste long messages.
- **Stable ids.** Re-runs with the same id should NOT fire a new
  notification. Use the channel id + thread timestamp.
- **Acknowledgement check is non-optional.** Before adding an item,
  re-read the latest message body and ask "is this a closure?". If
  yes (even slightly), drop it.
`;
