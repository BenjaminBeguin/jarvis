export default `---
name: calendar-today
description: Pull today's macOS Calendar events and write them as inbox items so they appear in the Inbox tab
allowed-tools:
  - Read
  - Write
  - Bash
---

You pull events from the user's macOS Calendar for the next ~12 hours
and write them as inbox items in the shape the Jarvis Inbox expects.
The Inbox auto-refreshes every 5 minutes and picks up the file.

## Output location

Write to exactly this path:

\`\`\`
~/.jarvis/inbox/calendar.json
\`\`\`

As a wrapper:

\`\`\`json
{
  "source": "calendar",
  "label": "Calendar today",
  "items": [ ... ]
}
\`\`\`

Overwrite on every run. Empty array is valid — it clears the section.

## How to query Calendar

Use \`osascript\` via Bash. AppleScript Calendar queries are slow and
require automation permission. Be defensive:

1. **First run will prompt the user** for "Calendar" automation
   access. If your script exits non-zero or times out, write an
   empty wrapper and stop — don't pretend you got data.

2. **Cap the query window**. Today + next 12 hours is plenty for an
   inbox. Don't pull a week — slow + noisy.

3. **Use a short timeout** (10 sec) on the osascript invocation.

Example one-liner (tweak the time window as needed):

\`\`\`bash
osascript <<'APPLESCRIPT'
set theStart to current date
set theEnd to theStart + 12 * hours
tell application "Calendar"
  set out to {}
  repeat with cal in calendars
    repeat with evt in (events of cal whose start date is greater than or equal to theStart and start date is less than theEnd)
      set evtUid to uid of evt
      set evtSum to summary of evt
      set evtStart to start date of evt
      set evtEnd to end date of evt
      copy {evtUid, evtSum, evtStart, evtEnd, name of cal} to end of out
    end repeat
  end repeat
  return out
end tell
APPLESCRIPT
\`\`\`

You'll get raw text back — parse it carefully. AppleScript date
formatting varies by locale. Best path: query each field separately
and assemble in your shell pipeline, OR have AppleScript emit a
delimiter-separated string per event.

## Output shape

Each event → one inbox item:

\`\`\`json
{
  "id": "calendar-<event-uid>",
  "title": "<summary>",
  "subtitle": "<calendar name> · HH:MM–HH:MM",
  "fireAt": <event start ms epoch>,
  "createdAt": <ms epoch now>
}
\`\`\`

Notes:
- \`fireAt\` makes the event sort to the top (time-pressured, soonest
  first).
- \`id\` MUST be stable across runs — use the Calendar UID. Re-runs
  with the same id don't trigger fresh notifications.
- No \`action\` needed — calendar events are informational unless the
  user has a "join meeting" URL, in which case set \`url\` to the
  meeting link.

## Hard rules

- **Quiet failure.** If osascript errors (no permission, no events,
  Calendar.app not running), write the empty wrapper and exit 0
  with a one-line message. Never throw.
- **Don't list all-day events** as scheduled items — those clutter
  the inbox. Skip events whose start date isn't a specific time.
- **Skip past events** even if the query window technically includes
  them.
- **One-line confirmation** when done: "Calendar: 4 events in next
  12h" or "Calendar: none scheduled".

## Setting it up

The user wires this on a routine, same as slack-inbox:

\`\`\`json
{
  "id": "calendar-today",
  "skillId": "calendar-today",
  "cron": "*/15 * * * *",
  "input": "Refresh calendar inbox.",
  "enabled": true
}
\`\`\`

Every 15 min is plenty — calendar events don't change minute-to-minute.
`;
