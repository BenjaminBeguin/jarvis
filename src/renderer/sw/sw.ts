/// <reference lib="webworker" />

import { precacheAndRoute } from 'workbox-precaching';

/**
 * Jarvis PWA service worker. Vite-plugin-pwa (injectManifest mode)
 * injects the precache manifest at build time via the
 * `self.__WB_MANIFEST` placeholder.
 *
 * Responsibilities:
 *   - skipWaiting + clients.claim so a new version takes over
 *     immediately when the user reopens the PWA.
 *   - Show Web Push notifications fanned out from the Mac's
 *     notifier (matches the desktop alerts).
 *   - On tap, deep-link into the right /#/mobile sub-view (the
 *     conversation if the payload carries a taskId, otherwise
 *     the inbox).
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string }>;
};

interface PushPayload {
  title?: string;
  body?: string;
  source?: string;
  taskId?: string;
  reminderId?: string;
  ts?: number;
}

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', () => {
  void self.clients.claim();
});

// Pre-cache the renderer build output (workbox-precaching) so
// the PWA loads from cache when reachability hiccups.
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('push', (event) => {
  const payload: PushPayload = (() => {
    try {
      return event.data ? (event.data.json() as PushPayload) : {};
    } catch {
      return event.data ? { body: event.data.text() } : {};
    }
  })();

  const title = payload.title?.trim() || 'Jarvis';
  const body = payload.body?.trim() || '';
  // Tag groups updates from the same task so we don't pile up
  // multiple banners on the lock screen for the same thread.
  const tag = payload.taskId
    ? `task:${payload.taskId}`
    : payload.reminderId
      ? `reminder:${payload.reminderId}`
      : payload.source ?? 'jarvis';

  // `renotify: true` would re-fire the banner for the same `tag`; not in
  // lib.dom's NotificationOptions, so cast through unknown rather than
  // dropping the hint for browsers that honour it.
  const options: NotificationOptions = {
    body,
    tag,
    icon: '/jarvis-icon.svg',
    badge: '/jarvis-icon.svg',
    data: payload,
  };
  (options as unknown as { renotify: boolean }).renotify = true;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data as PushPayload | undefined) ?? {};
  const target =
    data.taskId
      ? `/#/mobile?view=conversation&id=${encodeURIComponent(data.taskId)}`
      : '/#/mobile?view=inbox';
  event.waitUntil(focusOrOpen(target));
});

/** Focus an existing PWA window if one is open, otherwise open a
 *  new one at the deep-link target. Matches by origin so the SW
 *  doesn't get confused by an old tab pointed at a different URL. */
async function focusOrOpen(target: string): Promise<void> {
  const clientsList = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const client of clientsList) {
    try {
      const url = new URL(client.url);
      if (url.origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) {
          try {
            await (client as WindowClient).navigate(target);
          } catch {
            /* Some browsers (iOS) reject navigate; just focus. */
          }
        }
        return;
      }
    } catch {
      /* skip clients with non-URL refs */
    }
  }
  await self.clients.openWindow(target);
}
