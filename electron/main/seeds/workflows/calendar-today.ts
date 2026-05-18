import type { WorkflowDef } from '@shared/types';

/**
 * Calendar inbox workflow.
 *
 *   trigger:  every 10 min
 *   pipeline: osascript (JXA) → transform → inbox-write
 *
 * macOS-only. Uses JavaScript for Automation (JXA) instead of
 * AppleScript: same `osascript` host, JS syntax, native Date objects,
 * JSON output. The previous AppleScript version kept tripping over
 * operator-precedence quirks (`month of d as integer` etc.) — JXA
 * sidesteps the entire class of bugs.
 *
 * Quiet failure: if Calendar.app isn't running or automation
 * permission hasn't been granted, JXA throws and the workflow step
 * shows `errored`. The next tick recovers once permission is in place.
 */

// JXA: enumerate Calendar.app events in the next 12h and emit a JSON
// array. All the gnarly date math happens in real JavaScript on
// native Date objects — no string-concat ISO formatter to maintain.
const CAL_SCRIPT = `
(function () {
  const Calendar = Application('Calendar');
  const now = new Date();
  const end = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const out = [];
  const cals = Calendar.calendars();
  for (let i = 0; i < cals.length; i++) {
    const cal = cals[i];
    let evts;
    try {
      evts = cal.events.whose({
        _and: [
          { startDate: { _greaterThanEquals: now } },
          { startDate: { _lessThan: end } },
        ],
      })();
    } catch (e) {
      continue;
    }
    const calName = cal.name();
    for (let j = 0; j < evts.length; j++) {
      const evt = evts[j];
      try {
        out.push({
          uid: evt.uid(),
          summary: evt.summary() || '',
          startIso: evt.startDate().toISOString(),
          endIso: evt.endDate() ? evt.endDate().toISOString() : '',
          calendar: calName,
          location: evt.location() || '',
          description: evt.description() || '',
          allDay: evt.alldayEvent() === true,
        });
      } catch (e) {
        // Skip a single bad event; don't kill the whole sync.
      }
    }
  }
  return JSON.stringify(out);
})();
`;

// Transform receives the JSON string from JXA, parses it, and maps to
// InboxItem[]. No more TSV parsing — just JSON.parse + array methods.
const CAL_TRANSFORM = `((() => {
  const MEETING_URL_RE = /https?:\\/\\/[a-z0-9.-]*(?:meet\\.google|zoom\\.us|teams\\.microsoft|webex|whereby|jitsi)[^\\s<>\"']*/i;
  const hhmm = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }).replace(/\\s+/g, '');
  };
  let events = [];
  try { events = JSON.parse(typeof $ === 'string' ? $ : '[]'); } catch { events = []; }
  if (!Array.isArray(events)) events = [];
  return events
    .map((evt) => {
      const startMs = new Date(evt.startIso).getTime();
      if (!Number.isFinite(startMs)) return null;
      if (startMs < Date.now() - 60000) return null;
      if (evt.allDay) return null;
      const loc = String(evt.location || '');
      const desc = String(evt.description || '');
      const locMatch = loc.match(MEETING_URL_RE);
      const descMatch = desc.match(MEETING_URL_RE);
      const meetingUrl = (locMatch && locMatch[0]) || (descMatch && descMatch[0]) || null;
      const startLabel = hhmm(evt.startIso);
      const endLabel = hhmm(evt.endIso);
      const time = startLabel + (endLabel ? '–' + endLabel : '');
      const subtitle = [evt.calendar, time].filter(Boolean).join(' · ');
      return {
        id: 'calendar-' + evt.uid,
        source: 'calendar',
        title: String(evt.summary || '(untitled event)'),
        subtitle,
        fireAt: startMs,
        createdAt: Date.now(),
        ...(meetingUrl ? { url: meetingUrl } : {}),
      };
    })
    .filter((i) => i !== null)
    .sort((a, b) => (a.fireAt || 0) - (b.fireAt || 0));
})())`;

export const CALENDAR_TODAY_WORKFLOW: WorkflowDef = {
  id: 'calendar-today-sync',
  name: 'Sync Calendar today',
  description:
    'Every 10 minutes, pull upcoming events from Calendar.app for the next 12 hours.',
  enabled: true,
  trigger: { kind: 'cron', every: '10m' },
  pipeline: [
    {
      type: 'osascript',
      params: {
        script: CAL_SCRIPT,
        language: 'javascript',
        timeoutMs: 10_000,
      },
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
