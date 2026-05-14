export default `---
name: slack-inbox
description: Scan Slack for things waiting on me — DMs, mentions, unread threads in priority channels — and write them as inbox items
allowed-tools:
  - Read
  - Write
  - mcp__*
mcp-servers:
  - slack
---

You scan the user's Slack workspace for **things waiting on them** and
write the result as inbox items so they appear in the Jarvis Inbox tab.

The Inbox tab will pick up your output on its next 5-minute refresh.
Don't loop / poll — produce one pass of items and exit.

## What "waiting on me" means

Items the user genuinely owes a response or attention to:

- **Direct messages** they haven't responded to (oldest unread first)
- **@mentions** in any channel where the last message in the thread
  isn't from them
- **Threads in priority channels** where they were the previous
  participant and someone else replied after them

Things to **exclude**:

- Their own messages
- Auto-bots / GitHub notifications / Linear digests
- Channels they're a member of but rarely engage with (use message
  history as a proxy — if they haven't sent in there in 30 days,
  it's not a priority channel)
- Already-resolved threads (look for "thanks!", emoji acknowledgements
  on their reply, etc.)

## Process

1. **Discover the workspace.** Use \`mcp__slack__*\` tools. If the
   Slack MCP isn't connected, write an empty array to the output file
   (see below) and stop. Don't error.

2. **Pull recent DMs** — last ~48 hours. For each thread, identify the
   last sender. If it's NOT the user, the thread is waiting.

3. **Pull mentions** — search for \`@<user>\` across channels in the
   last ~24 hours. Same rule: if their reply isn't the last message,
   it's waiting.

4. **Triage to inbox items**, one per waiting thread:

   \`\`\`json
   {
     "id": "slack-<channel-id>-<thread-ts>",
     "title": "<sender>: <first 80 chars of latest message>",
     "subtitle": "<channel name> · <human-friendly age>",
     "url": "<slack permalink>",
     "createdAt": <ms epoch of the latest message>,
     "action": {
       "label": "Draft reply",
       "skillId": "send",
       "prompt": "Draft a Slack reply to <sender> in <#channel>: <context>"
     }
   }
   \`\`\`

   The \`id\` must be stable across runs so the Inbox can dedupe — use
   \`slack-<channel-id>-<thread-ts>\` exactly. The Inbox treats
   re-appearances of the same id as "not new" (no notification spam).

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
   is valid — clears the section in the Inbox.

6. **One-line confirmation** to the user: e.g. "3 Slack threads
   waiting (2 DMs, 1 mention)" or "Slack inbox clean." Nothing
   else — the Inbox tab does the surfacing.

## Hard rules

- **Never send a message** — you only produce inbox items. The user
  clicks Draft reply (which fires \`/send\`) to actually respond.
- **Don't include channel content** the user shouldn't see again as
  a notification body — keep titles to the first 80 chars, never
  paste long messages.
- If you can't tell whether a thread is "waiting" (ambiguous
  conversation), skip it rather than guess. False positives are noise.
- **Stable ids.** Re-runs with the same id should NOT fire a new
  notification. Use the channel id + thread timestamp.
`;
