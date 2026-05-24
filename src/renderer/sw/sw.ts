/// <reference lib="webworker" />

import { precacheAndRoute } from 'workbox-precaching';

/**
 * Jarvis PWA service worker. Vite-plugin-pwa (injectManifest mode)
 * injects the precache manifest at build time via the
 * `self.__WB_MANIFEST` placeholder. We own everything else:
 *
 *   - skipWaiting + clients.claim so a new version takes over
 *     immediately when the user reopens the PWA.
 *   - Push handler lands in a later commit (phase 8 of the
 *     mobile rollout); the stub is here so the build pipeline
 *     compiles cleanly today.
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string }>;
};

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', () => {
  void self.clients.claim();
});

// Pre-cache the renderer build output (workbox-precaching) so
// the PWA loads from cache when reachability hiccups.
precacheAndRoute(self.__WB_MANIFEST);

// Stub push handler — replaced in the Web Push commit. Current
// behaviour: no-op so any spurious push doesn't error the SW.
self.addEventListener('push', (event) => {
  // Phase 8 will: parse event.data.json(), call
  // self.registration.showNotification(...) with title/body/icon,
  // and route taps to /#/mobile/conversation/:id.
  void event;
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Phase 8 will resolve the right deep link from
  // notification.data and call clients.openWindow.
});
