import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const ok = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
});
const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const err = (msg: string): CallToolResult => ({
  content: [{ type: 'text', text: `error: ${msg}` }],
  isError: true,
});

/**
 * In-process MCP server for one Google account's Calendar API. Same
 * shape as the Gmail factory in this folder. Token is fetched lazily
 * per call so refreshes propagate without rebuilding the server.
 */
export function buildCalendarMcp(
  accountId: string,
  getAccessToken: () => Promise<string | null>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `calendar-${accountId}`,
    version: '0.1.0',
    tools: [
      tool(
        'list_calendars',
        `List every calendar visible to ${accountId} (primary, secondary, subscribed). Use the returned ids in subsequent calls.`,
        {},
        async () =>
          callCalendar(getAccessToken, async (token) => {
            const res = await fetch(
              'https://www.googleapis.com/calendar/v3/users/me/calendarList',
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as {
              items?: Array<{
                id: string;
                summary: string;
                primary?: boolean;
                accessRole?: string;
                timeZone?: string;
              }>;
            };
            return json(
              (data.items ?? []).map((c) => ({
                id: c.id,
                summary: c.summary,
                primary: !!c.primary,
                accessRole: c.accessRole,
                timeZone: c.timeZone,
              })),
            );
          }),
      ),
      tool(
        'list_events',
        'List events from a calendar. Defaults to the primary calendar and "next 14 days". `timeMin` / `timeMax` are ISO-8601 strings (e.g. 2026-06-12T09:00:00-07:00).',
        {
          calendarId: z.string().optional(),
          timeMin: z.string().optional(),
          timeMax: z.string().optional(),
          maxResults: z.number().int().min(1).max(100).optional(),
          query: z.string().optional(),
        },
        async (args) =>
          callCalendar(getAccessToken, async (token) => {
            const cal = args.calendarId ?? 'primary';
            const url = new URL(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`,
            );
            url.searchParams.set('singleEvents', 'true');
            url.searchParams.set('orderBy', 'startTime');
            url.searchParams.set(
              'timeMin',
              args.timeMin ?? new Date().toISOString(),
            );
            url.searchParams.set(
              'timeMax',
              args.timeMax ?? defaultTimeMax(),
            );
            url.searchParams.set(
              'maxResults',
              String(args.maxResults ?? 25),
            );
            if (args.query) url.searchParams.set('q', args.query);
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as {
              items?: Array<CalendarEvent>;
            };
            return json(
              (data.items ?? []).map((e) => slimEvent(e)),
            );
          }),
      ),
      tool(
        'freebusy',
        `Check ${accountId}'s availability across one or more calendars. Returns busy blocks within [timeMin, timeMax]. ISO-8601 strings.`,
        {
          timeMin: z.string(),
          timeMax: z.string(),
          calendarIds: z.array(z.string()).optional(),
        },
        async (args) =>
          callCalendar(getAccessToken, async (token) => {
            const ids =
              args.calendarIds && args.calendarIds.length
                ? args.calendarIds
                : ['primary'];
            const res = await fetch(
              'https://www.googleapis.com/calendar/v3/freeBusy',
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  timeMin: args.timeMin,
                  timeMax: args.timeMax,
                  items: ids.map((id) => ({ id })),
                }),
              },
            );
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as {
              calendars?: Record<
                string,
                { busy?: Array<{ start: string; end: string }> }
              >;
            };
            return json(data.calendars ?? {});
          }),
      ),
      tool(
        'create_event',
        'Create a calendar event. Times are ISO-8601 with a timezone offset (e.g. 2026-06-12T09:00:00-07:00). Attendees are optional emails.',
        {
          calendarId: z.string().optional(),
          summary: z.string().min(1),
          start: z.string(),
          end: z.string(),
          description: z.string().optional(),
          location: z.string().optional(),
          attendees: z.array(z.string()).optional(),
          sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
        },
        async (args) =>
          callCalendar(getAccessToken, async (token) => {
            const cal = args.calendarId ?? 'primary';
            const url = new URL(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`,
            );
            if (args.sendUpdates) {
              url.searchParams.set('sendUpdates', args.sendUpdates);
            }
            const body: Record<string, unknown> = {
              summary: args.summary,
              start: { dateTime: args.start },
              end: { dateTime: args.end },
            };
            if (args.description) body['description'] = args.description;
            if (args.location) body['location'] = args.location;
            if (args.attendees?.length) {
              body['attendees'] = args.attendees.map((email) => ({ email }));
            }
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            });
            if (!res.ok) return err(await res.text());
            const data = (await res.json()) as CalendarEvent;
            return ok(
              `event created · id ${data.id} · ${data.htmlLink ?? '(no link)'}`,
            );
          }),
      ),
      tool(
        'update_event',
        'Patch an existing event. Provide only the fields you want to change.',
        {
          calendarId: z.string().optional(),
          eventId: z.string().min(1),
          summary: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          attendees: z.array(z.string()).optional(),
          sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
        },
        async (args) =>
          callCalendar(getAccessToken, async (token) => {
            const cal = args.calendarId ?? 'primary';
            const url = new URL(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(args.eventId)}`,
            );
            if (args.sendUpdates) {
              url.searchParams.set('sendUpdates', args.sendUpdates);
            }
            const body: Record<string, unknown> = {};
            if (args.summary !== undefined) body['summary'] = args.summary;
            if (args.start) body['start'] = { dateTime: args.start };
            if (args.end) body['end'] = { dateTime: args.end };
            if (args.description !== undefined) body['description'] = args.description;
            if (args.location !== undefined) body['location'] = args.location;
            if (args.attendees?.length) {
              body['attendees'] = args.attendees.map((email) => ({ email }));
            }
            const res = await fetch(url, {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            });
            if (!res.ok) return err(await res.text());
            return ok(`event ${args.eventId} updated`);
          }),
      ),
      tool(
        'delete_event',
        'Cancel an event. Set sendUpdates to notify attendees.',
        {
          calendarId: z.string().optional(),
          eventId: z.string().min(1),
          sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
        },
        async (args) =>
          callCalendar(getAccessToken, async (token) => {
            const cal = args.calendarId ?? 'primary';
            const url = new URL(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(args.eventId)}`,
            );
            if (args.sendUpdates) {
              url.searchParams.set('sendUpdates', args.sendUpdates);
            }
            const res = await fetch(url, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok && res.status !== 410) return err(await res.text());
            return ok(`event ${args.eventId} deleted`);
          }),
      ),
    ],
  });
}

interface CalendarEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email: string;
    responseStatus?: string;
    organizer?: boolean;
  }>;
  organizer?: { email: string };
  hangoutLink?: string;
}

function slimEvent(e: CalendarEvent): Record<string, unknown> {
  return {
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location,
    hangoutLink: e.hangoutLink,
    attendees: e.attendees?.map((a) => ({
      email: a.email,
      responseStatus: a.responseStatus,
    })),
    htmlLink: e.htmlLink,
  };
}

function defaultTimeMax(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString();
}

async function callCalendar(
  getAccessToken: () => Promise<string | null>,
  fn: (token: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const token = await getAccessToken();
  if (!token) {
    return err(
      'No valid Google access token. Reconnect this account from Settings → Integrations.',
    );
  }
  try {
    return await fn(token);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
