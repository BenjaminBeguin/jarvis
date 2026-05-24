import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import webpush, { type PushSubscription } from 'web-push';

import { getJarvisVapidKeys, setJarvisVapidKeys } from './secrets.js';

/**
 * Web Push fan-out for the mobile PWA.
 *
 * - VAPID keypair: generated once, persisted to Keychain (Jarvis
 *   account `jarvis-vapid`). Sent to the PWA on subscribe so it
 *   can register against the right server identity.
 * - Subscriptions: stored at ~/.jarvis/push-subscriptions.json,
 *   keyed by an opaque device id the PWA generates. Stale
 *   endpoints (410 Gone from the push service) get pruned on the
 *   next send.
 * - Fan-out: any caller can `pushToAll(payload)`; the notifier
 *   subscriber in main wires the post-to-everyone flow.
 */

interface StoredSubscription {
  deviceId: string;
  subscription: PushSubscription;
  registeredAt: number;
}

interface SubscriptionFile {
  subscriptions: StoredSubscription[];
}

const SUBJECT = 'mailto:jarvis@local.invalid';
let publicKey: string | null = null;
let privateKey: string | null = null;
let ready = false;

const subsPath = (): string =>
  join(homedir(), '.jarvis', 'push-subscriptions.json');

function readStore(): SubscriptionFile {
  const p = subsPath();
  if (!existsSync(p)) return { subscriptions: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as SubscriptionFile;
    if (Array.isArray(parsed?.subscriptions)) return parsed;
  } catch (err) {
    console.warn('[push] failed to read subscription store', err);
  }
  return { subscriptions: [] };
}

function writeStore(file: SubscriptionFile): void {
  const p = subsPath();
  mkdirSync(join(homedir(), '.jarvis'), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2), 'utf8');
}

export async function initPush(): Promise<void> {
  let keys = await getJarvisVapidKeys();
  if (!keys) {
    const generated = webpush.generateVAPIDKeys();
    await setJarvisVapidKeys(generated.publicKey, generated.privateKey);
    keys = generated;
    console.log('[push] generated new VAPID keypair');
  }
  publicKey = keys.publicKey;
  privateKey = keys.privateKey;
  webpush.setVapidDetails(SUBJECT, publicKey, privateKey);
  ready = true;
}

export function getPublicKey(): string | null {
  return publicKey;
}

export function isReady(): boolean {
  return ready;
}

export function saveSubscription(
  deviceId: string,
  subscription: PushSubscription,
): void {
  const file = readStore();
  // Replace any prior registration for the same device (the SW
  // re-subscribes on each install + after the user re-pairs).
  const filtered = file.subscriptions.filter((s) => s.deviceId !== deviceId);
  filtered.push({
    deviceId,
    subscription,
    registeredAt: Date.now(),
  });
  writeStore({ subscriptions: filtered });
}

export function removeSubscription(deviceId: string): void {
  const file = readStore();
  const filtered = file.subscriptions.filter((s) => s.deviceId !== deviceId);
  writeStore({ subscriptions: filtered });
}

/**
 * Send a payload to every registered subscription. Drops
 * stale ones (410 Gone) from the store so the next fan-out
 * doesn't re-try them.
 */
export async function pushToAll(payload: unknown): Promise<void> {
  if (!ready) return;
  const file = readStore();
  if (file.subscriptions.length === 0) return;
  const text = JSON.stringify(payload);
  const stale: string[] = [];
  await Promise.allSettled(
    file.subscriptions.map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription, text, { TTL: 60 });
      } catch (err: unknown) {
        const e = err as { statusCode?: number; body?: string } | undefined;
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          stale.push(s.deviceId);
        } else {
          console.warn('[push] send failed', e?.statusCode, e?.body ?? err);
        }
      }
    }),
  );
  if (stale.length > 0) {
    const next = file.subscriptions.filter((s) => !stale.includes(s.deviceId));
    writeStore({ subscriptions: next });
    console.log(`[push] pruned ${stale.length} stale subscription(s)`);
  }
}
