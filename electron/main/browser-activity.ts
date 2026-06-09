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
 * time to immediately stop receiving signal. Subscribers (the
 * Activity feed) only see what's in RAM right now — quitting Jarvis
 * wipes the slate.
 */
import { EventEmitter } from 'node:events';

export interface BrowserActivityEvent {
  url: string;
  title: string;
  at: number;
}

const MAX_ITEMS = 50;
const MAX_AGE_MS = 60 * 60_000; // 1 hour rolling window

let buffer: BrowserActivityEvent[] = [];
const emitter = new EventEmitter();

/** Subscribe to new browser events for live UI updates. The
 *  callback receives the event that was just appended (or the
 *  existing entry whose timestamp got refreshed on a heartbeat).
 *  Returns an unsubscribe function. */
export function onBrowserActivity(
  listener: (event: BrowserActivityEvent) => void,
): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

export function recordBrowserActivity(event: BrowserActivityEvent): void {
  // Dedup against the most-recent entry — heartbeats from the
  // extension would otherwise bloat the buffer with the same URL.
  const last = buffer[buffer.length - 1];
  if (last && last.url === event.url) {
    // Update the timestamp instead of pushing a duplicate so the
    // "still here" signal stays current.
    last.at = event.at;
    emitter.emit('event', last);
    return;
  }
  buffer.push(event);
  // Cap.
  if (buffer.length > MAX_ITEMS) {
    buffer = buffer.slice(-MAX_ITEMS);
  }
  emitter.emit('event', event);
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
  emitter.emit('event', { url: '', title: '', at: 0 });
}
