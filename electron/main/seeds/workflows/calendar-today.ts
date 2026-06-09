import type { WorkflowDef } from '@shared/types';

/**
 * Calendar inbox workflow.
 *
 *   trigger:  every 10 min
 *   pipeline: mcp-call (Google Calendar) → transform → inbox-write
 *
 * Pulls upcoming events from your **Google Calendar** via the
 * OAuth-managed `calendar-*` MCP server (Settings → Integrations →
 * Connected accounts → Google). Replaces an earlier osascript/JXA
 * approach that tripped over macOS Calendar.app's permission and
 * scripting-target quirks (-1701 / -2753 errors that even Apple's
 * own AppleScript snippets couldn't reproduce reliably).
 *
 * Trade-off: requires the user to have connected a Google account.
 * Without one, the workflow errors with a friendly "MCP server
 * 'calendar' not registered" message — far easier to diagnose than
 * Calendar.app's silent failures. If you live in iCloud / Exchange
 * land and need those calendars, duplicate this workflow and swap
 * the `mcp-call` for an `osascript` step against Calendar.app once
 * you've granted automation access in System Settings.
 *
 * Prefix-matching on the `mcp` id means `'calendar'` resolves to
 * whichever `calendar-<accountId>` is registered first — single
 * account by default. To pick a specific account, use the full id
 * (e.g. `calendar-personal@example.com`).
 */

// list_events defaults to "next 14 days, 25 results ordered by
// startTime" when no timeMin/timeMax is passed (see google-mcp/
// calendar.ts). We bump maxResults so a busy fortnight doesn't
// truncate before the transform can window down.
const CAL_TRANSFORM = `((() => {
  const MEETING_URL_RE = /https?:\\/\\/[a-z0-9.-]*(?:meet\\.google|zoom\\.us|teams\\.microsoft|webex|whereby|jitsi)[^\\s<>\"']*/i;
  const hhmm = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }).replace(/\\s+/g, '');
  };
  // mcp-call parse:'json' returns an array whose first element is
  // the slimEvent[] from the calendar MCP. Walk every block + flatten
  // so a future MCP that returns multiple text blocks still works.
  const blocks = Array.isArray($) ? $ : [$];
  const events = [];
  for (const b of blocks) {
    if (Array.isArray(b)) events.push(...b);
  }
  // 14-day window: covers the rest of this week + all of next week,
  // regardless of which day the user opens the app. Earlier 12h /
  // 24h windows silently dropped meetings any time you checked
  // outside of the same-day window.
  const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const horizon = now + LOOKAHEAD_MS;
  return events
    .map((evt) => {
      if (!evt || typeof evt !== 'object') return null;
      const startIso = evt.start;
      const endIso = evt.end;
      const startMs = startIso ? new Date(startIso).getTime() : NaN;
      if (!Number.isFinite(startMs)) return null;
      // Skip past events + anything beyond the 14-day window. The
      // mcp tool returns up to 14 days by default; we keep the
      // filter so a future MCP that returns more (e.g. 30 days)
      // still respects the workflow's stated horizon.
      if (startMs < now - 60_000) return null;
      if (startMs > horizon) return null;
      // All-day events have date (YYYY-MM-DD) on start/end instead of
      // dateTime. We skip those — they clutter a time-pressured inbox.
      const isAllDay = typeof startIso === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(startIso);
      if (isAllDay) return null;
      const loc = String(evt.location || '');
      const hangout = String(evt.hangoutLink || '');
      const locMatch = loc.match(MEETING_URL_RE);
      const meetingUrl = hangout || (locMatch && locMatch[0]) || null;
      const startLabel = hhmm(startIso);
      const endLabel = endIso ? hhmm(endIso) : '';
      const time = startLabel + (endLabel ? '–' + endLabel : '');
      const subtitle = time || (loc.length > 0 && loc.length < 60 ? loc : '');
      // Surface attendee count so the meeting heads-up prompt can
      // skip solo blockers / focus blocks (single-attendee = me only,
      // not a meeting). The MCP slim shape carries declined attendees
      // too — filter those out so a calendar with 3 invitees but
      // 2 declines reads as a 1-person event (= no prompt).
      const attendees = Array.isArray(evt.attendees) ? evt.attendees : [];
      const accepted = attendees.filter(
        (a) => a && a.responseStatus !== 'declined',
      );
      const attendeeCount = accepted.length || 1;
      return {
        id: 'calendar-' + (evt.id || startIso),
        source: 'calendar',
        title: String(evt.summary || '(untitled event)'),
        subtitle,
        fireAt: startMs,
        createdAt: Date.now(),
        attendeeCount,
        ...(meetingUrl ? { url: meetingUrl } : evt.htmlLink ? { url: evt.htmlLink } : {}),
      };
    })
    .filter((i) => i !== null)
    .sort((a, b) => (a.fireAt || 0) - (b.fireAt || 0));
})())`;

export const CALENDAR_TODAY_WORKFLOW: WorkflowDef = {
  id: 'calendar-today-sync',
  name: 'Sync Calendar (2 weeks)',
  description:
    'Every 10 minutes, pull upcoming Google Calendar events for the next 14 days (this week + next week) via the OAuth-managed calendar MCP. Requires a connected Google account.',
  enabled: true,
  trigger: { kind: 'cron', every: '10m' },
  pipeline: [
    {
      type: 'mcp-call',
      params: {
        mcp: 'calendar',
        tool: 'list_events',
        args: { maxResults: 50 },
        parse: 'json',
      },
    },
    {
      type: 'transform',
      params: { fn: CAL_TRANSFORM },
    },
    {
      type: 'inbox-write',
      params: { source: 'calendar', label: 'Calendar' },
    },
  ],
};
