/**
 * In-memory ring buffer of recent active-tab events from the Chrome
 * extension. Drives the `browser-activity` context provider so every
 * Claude turn knows what the user was just looking at — relevant PRs,
 * Linear tickets, docs they opened, etc.
 *
 * Pure RAM, no disk persistence (intentional — browsing is sensitive,
 * we shouldn't keep a journal). The buffer rolls over after MAX_ITEMS
 * and entries older than MAX_AGE_MS are dropped on every read.
 *
 * The privacy story: the user opts in via the Browser module setting,
 * provides an exclude list (the Chrome extension drops matching URLs
 * before they leave the browser), and can flip the toggle off at any
 * time to immediately stop receiving signal.
 */

export interface BrowserActivityEvent {
  url: string;
  title: string;
  at: number;
}

const MAX_ITEMS = 50;
const MAX_AGE_MS = 60 * 60_000; // 1 hour rolling window

let buffer: BrowserActivityEvent[] = [];

export function recordBrowserActivity(event: BrowserActivityEvent): void {
  // Dedup against the most-recent entry — heartbeats from the
  // extension would otherwise bloat the buffer with the same URL.
  const last = buffer[buffer.length - 1];
  if (last && last.url === event.url) {
    // Update the timestamp instead of pushing a duplicate so the
    // "still here" signal stays current.
    last.at = event.at;
    return;
  }
  buffer.push(event);
  // Cap.
  if (buffer.length > MAX_ITEMS) {
    buffer = buffer.slice(-MAX_ITEMS);
  }
}

export function readRecentActivity(
  windowMs: number = MAX_AGE_MS,
): BrowserActivityEvent[] {
  const cutoff = Date.now() - windowMs;
  buffer = buffer.filter((e) => e.at >= cutoff);
  return [...buffer];
}

export function clearBrowserActivity(): void {
  buffer = [];
}
