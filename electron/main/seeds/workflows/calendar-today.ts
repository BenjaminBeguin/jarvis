import type { WorkflowDef } from '@shared/types';

/**
 * Calendar inbox workflow.
 *
 *   trigger:  every 5 min
 *   pipeline: osascript → transform → inbox-write
 *
 * macOS-only. The osascript reads events from Calendar.app for the
 * next 12 hours and emits one TAB-delimited line per event. The
 * transform parses and filters to "upcoming, not all-day", maps each
 * to an InboxItem with fireAt set to start time (drives the time-
 * pressure sort + the proximity reminder).
 *
 * Quiet failure: if Calendar.app isn't running or automation
 * permission hasn't been granted, osascript errors and the workflow
 * step shows `errored` — the next tick recovers automatically once
 * permission is in place.
 */

// AppleScript: pull next 12 hours of events from Calendar.app and
// emit one TAB-delimited line per event. ISO 8601 built by hand.
//
// Quirks worked around:
//   - The «class isot» token is rejected on newer macOS (-2741
//     "Expected ',' but found class name"). Don't use it.
//   - AppleScript's `as` binds tightly enough inside function-call
//     parens that `pad2(month of d as integer)` is parsed as
//     `pad2(month of (d as integer))` and trips the SAME -2741
//     because `d as integer` is invalid for a date. Pre-compute
//     every component into a local so the call sites are bare
//     identifiers — no nested `as` inside `pad2(…)`.
const CAL_SCRIPT = `
on pad2(n)
  set s to n as text
  if (length of s) < 2 then return "0" & s
  return s
end pad2

on isoStr(d)
  set y to year of d
  set mo to (month of d) as integer
  set da to day of d
  set hh to hours of d
  set mn to minutes of d
  set ss to seconds of d
  return (y as text) & "-" & pad2(mo) & "-" & pad2(da) & "T" & pad2(hh) & ":" & pad2(mn) & ":" & pad2(ss)
end isoStr

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
      try
        set evtAllDay to allday event of evt
      on error
        set evtAllDay to false
      end try
      set startIso to my isoStr(start date of evt)
      set endIso to my isoStr(end date of evt)
      set out to out & (uid of evt) & TAB & (summary of evt) & TAB & startIso & TAB & endIso & TAB & (name of cal) & TAB & evtLoc & TAB & evtDesc & TAB & evtAllDay & linefeed
    end repeat
  end repeat
end tell
return out
`;

const CAL_TRANSFORM = `((() => {
  const MEETING_URL_RE = /https?:\\/\\/[a-z0-9.-]*(?:meet\\.google|zoom\\.us|teams\\.microsoft|webex|whereby|jitsi)[^\\s<>\"']*/i;
  const hhmm = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }).replace(/\\s+/g, '');
  };
  return ((typeof $ === 'string' ? $ : '')
    .split('\\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\\t');
      if (parts.length < 8) return null;
      const [uid, summary, startIso, endIso, calendar, location, description, allDayRaw] = parts;
      if (!uid || !summary || !startIso) return null;
      return { uid, summary, startIso, endIso: endIso || '', calendar: calendar || '', location: location || '', description: description || '', allDay: (allDayRaw || '').trim().toLowerCase() === 'true' };
    })
    .filter(e => e !== null)
    .map(evt => {
      const startMs = new Date(evt.startIso).getTime();
      if (!Number.isFinite(startMs)) return null;
      if (startMs < Date.now() - 60000) return null;
      if (evt.allDay) return null;
      const locMatch = evt.location.match(MEETING_URL_RE);
      const descMatch = evt.description.match(MEETING_URL_RE);
      const meetingUrl = (locMatch && locMatch[0]) || (descMatch && descMatch[0]) || null;
      const startLabel = hhmm(evt.startIso);
      const endLabel = hhmm(evt.endIso);
      const time = startLabel + (endLabel ? '–' + endLabel : '');
      const subtitle = [evt.calendar, time].filter(Boolean).join(' · ');
      return {
        id: 'calendar-' + evt.uid,
        source: 'calendar',
        title: evt.summary,
        subtitle,
        fireAt: startMs,
        createdAt: Date.now(),
        ...(meetingUrl ? { url: meetingUrl } : {}),
      };
    })
    .filter(i => i !== null)
    .sort((a, b) => (a.fireAt || 0) - (b.fireAt || 0)));
})())`;

export const CALENDAR_TODAY_WORKFLOW: WorkflowDef = {
  id: 'calendar-today-sync',
  name: 'Sync Calendar today',
  description:
    'Every 5 minutes, pull upcoming events from Calendar.app for the next 12 hours.',
  enabled: true,
  trigger: { kind: 'cron', every: '5m' },
  pipeline: [
    {
      type: 'osascript',
      params: { script: CAL_SCRIPT, timeoutMs: 10_000 },
    },
    {
      type: 'transform',
      params: { fn: CAL_TRANSFORM },
    },
    {
      type: 'inbox-write',
      params: { source: 'calendar', label: 'Calendar today' },
    },
  ],
};
