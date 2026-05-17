import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { InboxItem } from '@shared/types';

import type { InboxSource } from '../inbox.js';

const execFileAsync = promisify(execFile);

/**
 * Direct-JS Calendar inbox source. Replaces the cron-fired
 * `calendar-today` skill — the actual work (osascript against
 * Calendar.app) happens here in TS, no agent.
 *
 * The skill's value-add was zero — it just wrapped the same
 * osascript invocation. Moving it out eliminates the per-fire
 * cold-start cost without changing user-visible behavior.
 *
 * Quiet failure: if Calendar.app isn't running, the user hasn't
 * granted automation permission, or osascript times out, we return
 * [] rather than throwing. The inbox tab stays functional.
 *
 * macOS-only — non-darwin platforms get an empty inbox from this
 * source (no log spam).
 */

const LOOKAHEAD_HOURS = 12;
const OSASCRIPT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000; // calendar events change slowly

/** AppleScript that emits one TAB-delimited line per event in the
 *  next LOOKAHEAD_HOURS hours. Same shape as the skill. */
const SCRIPT = `
set theStart to current date
set theEnd to theStart + ${LOOKAHEAD_HOURS} * hours
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
      set out to out & (uid of evt) & TAB & (summary of evt) & TAB & ((start date of evt) as «class isot» as string) & TAB & ((end date of evt) as «class isot» as string) & TAB & (name of cal) & TAB & evtLoc & TAB & evtDesc & TAB & evtAllDay & linefeed
    end repeat
  end repeat
end tell
return out
`;

const MEETING_URL_RE =
  /https?:\/\/[a-z0-9.-]*(?:meet\.google|zoom\.us|teams\.microsoft|webex|whereby|jitsi)[^\s<>"']*/i;

interface ParsedEvent {
  uid: string;
  summary: string;
  startIso: string;
  endIso: string;
  calendar: string;
  location: string;
  description: string;
  allDay: boolean;
}

function parseLine(line: string): ParsedEvent | null {
  const parts = line.split('\t');
  if (parts.length < 8) return null;
  const [uid, summary, startIso, endIso, calendar, location, description, allDayRaw] = parts;
  if (!uid || !summary || !startIso) return null;
  return {
    uid,
    summary,
    startIso,
    endIso: endIso ?? '',
    calendar: calendar ?? '',
    location: location ?? '',
    description: description ?? '',
    allDay: (allDayRaw ?? '').trim().toLowerCase() === 'true',
  };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    .replace(/\s+/g, '');
}

function eventToItem(evt: ParsedEvent): InboxItem | null {
  const startMs = new Date(evt.startIso).getTime();
  if (!Number.isFinite(startMs)) return null;
  // Skip past events even if technically in the lookahead window (the
  // AppleScript filter is "start >= now", but the user expects
  // "starting from now forward").
  if (startMs < Date.now() - 60_000) return null;
  // Skip all-day events — they clutter the time-pressured inbox.
  if (evt.allDay) return null;

  const meetingUrl =
    evt.location.match(MEETING_URL_RE)?.[0] ??
    evt.description.match(MEETING_URL_RE)?.[0] ??
    null;

  const startLabel = hhmm(evt.startIso);
  const endLabel = hhmm(evt.endIso);
  const time = startLabel + (endLabel ? `–${endLabel}` : '');
  const subtitle = [evt.calendar, time].filter(Boolean).join(' · ');

  return {
    id: `calendar-${evt.uid}`,
    source: 'calendar',
    title: evt.summary,
    subtitle,
    fireAt: startMs,
    createdAt: Date.now(),
    ...(meetingUrl ? { url: meetingUrl } : {}),
  };
}

let cached: { at: number; items: InboxItem[] } | null = null;
let loggedFailure = 0;

export function calendarInboxSource(): InboxSource {
  return {
    name: 'calendar',
    label: 'Calendar today',
    async fetch(): Promise<InboxItem[]> {
      if (process.platform !== 'darwin') return [];
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.items;
      }
      try {
        const { stdout } = await execFileAsync('osascript', ['-e', SCRIPT], {
          timeout: OSASCRIPT_TIMEOUT_MS,
        });
        const items = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map(parseLine)
          .filter((e): e is ParsedEvent => !!e)
          .map(eventToItem)
          .filter((i): i is InboxItem => !!i)
          .sort((a, b) => (a.fireAt ?? 0) - (b.fireAt ?? 0));
        cached = { at: Date.now(), items };
        return items;
      } catch (err) {
        const now = Date.now();
        if (now - loggedFailure > 5 * 60_000) {
          loggedFailure = now;
          // First-run case: macOS prompts for Calendar automation
          // access on the first osascript call. Until the user
          // approves, we hit an error here — quiet by design.
          console.info(
            '[inbox/calendar] osascript failed (permission or Calendar.app not running):',
            err instanceof Error ? err.message : err,
          );
        }
        return cached?.items ?? [];
      }
    },
  };
}
