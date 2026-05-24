import type { MobileAuth } from './types';

/**
 * The mobile PWA holds its bearer token + base URL in
 * localStorage so the user only pairs once. Pairing flow lands
 * in the next commit (QR scan); this module exposes the read /
 * write primitives now so the rest of the scaffold compiles.
 */

const KEY = 'jarvis.mobile.auth';

export function loadAuth(): MobileAuth | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MobileAuth>;
    if (
      typeof parsed?.baseUrl === 'string' &&
      typeof parsed?.token === 'string' &&
      parsed.baseUrl &&
      parsed.token
    ) {
      return { baseUrl: parsed.baseUrl, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAuth(auth: MobileAuth): void {
  localStorage.setItem(KEY, JSON.stringify(auth));
}

export function clearAuth(): void {
  localStorage.removeItem(KEY);
}

/** Parse `{ url, token }` from a string scanned out of the
 *  pairing QR. Returns null if the payload isn't shaped right
 *  so the login screen can show a friendly error instead of
 *  silently saving garbage. */
export function parseQrPayload(raw: string): MobileAuth | null {
  try {
    const obj = JSON.parse(raw) as Partial<MobileAuth>;
    if (
      typeof obj?.baseUrl === 'string' &&
      typeof obj?.token === 'string' &&
      obj.baseUrl &&
      obj.token
    ) {
      return { baseUrl: obj.baseUrl, token: obj.token };
    }
  } catch {
    /* fall through */
  }
  return null;
}
