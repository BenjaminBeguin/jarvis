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

Example AppleScript that emits one delimited line per event,
including the event's location and description so you can extract the
meeting URL on the shell side:

\`\`\`bash
osascript <<'APPLESCRIPT'
set theStart to current date
set theEnd to theStart + 12 * hours
set TAB to (ASCII character 9)
set out to ""
tell application "Calendar"
  repeat with cal in calendars
    repeat with evt in (events of cal whose start date is greater than or equal to theStart and start date is less than theEnd)
      try
        set evtLoc to location of evt
      on error
        set evtLoc to ""
      end try
      try
        set evtDesc to description of evt
      on error
        set evtDesc to ""
      end try
      set out to out & (uid of evt) & TAB & (summary of evt) & TAB & ((start date of evt) as «class isot» as string) & TAB & ((end date of evt) as «class isot» as string) & TAB & (name of cal) & TAB & evtLoc & TAB & evtDesc & linefeed
    end repeat
  end repeat
end tell
return out
APPLESCRIPT
\`\`\`

Each line is tab-separated: \`uid \\t summary \\t startISO \\t endISO \\t
calendar \\t location \\t description\`. Parse line-by-line.

To extract the meeting URL: regex over \`location\` first, then
\`description\` if location is plain text. Common patterns:

\`\`\`
https?:\\/\\/[a-z0-9.-]*(?:meet\\.google|zoom\\.us|teams\\.microsoft|webex|whereby|jitsi)[^\\s<>"']*
\`\`\`

## Output shape

Each event → one inbox item:

\`\`\`json
{
  "id": "calendar-<event-uid>",
  "title": "<summary>",
  "subtitle": "<calendar name> · HH:MM–HH:MM",
  "fireAt": <event start ms epoch>,
  "createdAt": <ms epoch now>,
  "url": "<meeting link if extractable>"
}
\`\`\`

Notes:
- \`fireAt\` makes the event sort to the top AND triggers Jarvis's
  proximity notification 5 min before — so set this accurately.
- \`id\` MUST be stable across runs — use the Calendar UID. Re-runs
  with the same id don't trigger fresh notifications.
- **Extract the meeting URL** from the event's \`location\` field OR
  \`description\` / \`notes\` body. Look for:
  - \`meet.google.com/...\` (Google Meet)
  - \`zoom.us/j/...\` (Zoom)
  - \`teams.microsoft.com/...\` (Teams)
  - \`webex.com/meet/...\` (Webex)

  When the user clicks the proximity notification, Jarvis opens the
  URL directly — saves them from hunting in the calendar app. If no
  URL is found, omit the field; the notification still works, click
  just jumps to the Inbox.

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
