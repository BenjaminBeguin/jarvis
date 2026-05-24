import { useEffect, useRef } from 'react';

import { api } from './api';
import type { MobileAuth } from './types';

/**
 * Register the PWA for Web Push the first time it loads after
 * pairing, then keep the server's subscription store in sync.
 *
 * Flow on first run:
 *   1. Bail if the browser can't do Web Push (older iOS, private
 *      Safari, etc.).
 *   2. Request Notification permission (no-op if already decided).
 *   3. Pull the server's VAPID public key.
 *   4. Ask the SW's pushManager to subscribe (or reuse the existing
 *      subscription if the keys still match).
 *   5. POST { deviceId, subscription } to /v1/push/subscribe so the
 *      Mac can fan-out to us.
 *
 * Device id is an opaque random string persisted to localStorage so
 * a re-install on the same phone replaces the old registration
 * cleanly rather than piling up dead endpoints.
 */
export function usePushRegistration(auth: MobileAuth | null): void {
  const ranRef = useRef(false);

  useEffect(() => {
    if (!auth) return;
    if (ranRef.current) return;
    ranRef.current = true;
    void registerPush(auth).catch((err) => {
      console.warn('[push] registration failed', err);
    });
  }, [auth]);
}

const DEVICE_ID_KEY = 'jarvis.mobile.deviceId';

function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function registerPush(auth: MobileAuth): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!('Notification' in window)) return;

  // The SW must be controlling the page before pushManager has anything
  // to attach to. The /sw.js registration in main.tsx fires this off; we
  // wait on `ready` so we don't race the first install.
  const reg = await navigator.serviceWorker.ready;

  let perm = Notification.permission;
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (perm !== 'granted') return;

  const keyResp = await api<{ publicKey: string }>(auth, '/v1/push/key');
  const appServerKey = urlBase64ToArrayBuffer(keyResp.publicKey);

  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // If the server VAPID key has rotated since the last subscribe,
    // the existing subscription would be DOA — re-subscribe with the
    // current key. Comparing the applicationServerKey buffer is the
    // only reliable signal here.
    const existingKey = sub.options.applicationServerKey;
    if (existingKey && !arrayBufferEquals(existingKey, appServerKey)) {
      try {
        await sub.unsubscribe();
      } catch {
        /* not fatal */
      }
      sub = null;
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });
  }

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;

  await api<{ ok: boolean }>(auth, '/v1/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: getOrCreateDeviceId(),
      subscription: {
        endpoint: json.endpoint,
        keys: {
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
        },
      },
    }),
  });
}

function urlBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const padded = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  // Allocate a fresh ArrayBuffer (rather than relying on Uint8Array's
  // ArrayBufferLike) so pushManager.subscribe + the buffer-equality
  // check both see a strict ArrayBuffer under strict TS lib types.
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

function arrayBufferEquals(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}
