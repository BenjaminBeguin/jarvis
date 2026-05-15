import type { ComponentType } from 'react';

import { CalendarPage } from './CalendarPage';
import { CapturePage } from './CapturePage';
import { MeetingsPage } from './MeetingsPage';

/**
 * Maps module id → renderer page component. A module appears with a "View"
 * affordance in the Modules tab only if it has an entry here.
 *
 * Adding a new module page: drop a file under src/renderer/modules/, export
 * its component, and register it here. The main-process module registry
 * mirrors this list under PAGED_MODULES so listModules() emits hasPage:true.
 *
 * 'quick-note' and 'reminders' both map to the same CapturePage, just
 * with different initial tabs — they're conceptually one "capture for
 * later" surface. Only quick-note shows in the Pages sub-nav (main's
 * PAGED_MODULES drops reminders); /reminders palette nav still works
 * via the captureTab signal in Shell.applyNav.
 */
export const MODULE_PAGES: Record<string, ComponentType> = {
  'quick-note': () => <CapturePage initial="notes" />,
  reminders: () => <CapturePage initial="reminders" />,
  'meeting-recorder': MeetingsPage,
  calendar: CalendarPage,
};

export function getModulePage(id: string): ComponentType | null {
  return MODULE_PAGES[id] ?? null;
}
