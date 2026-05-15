import type { ComponentType } from 'react';

import { CalendarPage } from './CalendarPage';
import { MeetingsPage } from './MeetingsPage';
import { QuickNotePage } from './QuickNotePage';

/**
 * Maps module id → renderer page component. A module appears with a "View"
 * affordance in the Modules tab only if it has an entry here.
 *
 * Adding a new module page: drop a file under src/renderer/modules/, export
 * its component, and register it here. The main-process module registry
 * mirrors this list under PAGED_MODULES so listModules() emits hasPage:true.
 */
export const MODULE_PAGES: Record<string, ComponentType> = {
  'quick-note': QuickNotePage,
  'meeting-recorder': MeetingsPage,
  calendar: CalendarPage,
};

export function getModulePage(id: string): ComponentType | null {
  return MODULE_PAGES[id] ?? null;
}
