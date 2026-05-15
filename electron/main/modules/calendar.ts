import type { Module } from './types.js';

/**
 * Calendar module. Page-only — no palette intents. The renderer page
 * (src/renderer/modules/CalendarPage.tsx) aggregates calendar events,
 * reminders, scheduled actions, and routine fires into Month / Week /
 * Day / Agenda views. No main-side state is needed because all the
 * data sources (inbox, reminders, routines) are already managed by
 * their own stores; the page just reads them.
 */
export const calendarModule: Module = {
  id: 'calendar',
  name: 'Calendar',
  description:
    'Month / Week / Day / Agenda views over Google Calendar + reminders + routine fires',
  version: '1.0.0',
};
