import type { MobileAuth } from './types';

/**
 * Tiny typed wrapper over fetch for the PWA. Adds the bearer
 * token, throws on non-2xx, JSON-parses the body. Lives separately
 * from the desktop's IPC layer so the mobile bundle doesn't have
 * to import any Electron-only types.
 */
export async function api<T>(
  auth: MobileAuth,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${auth.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  // Default Content-Type for POST with object body — caller can
  // override via init.headers.
  if (init?.method && init.method !== 'GET' && init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      `${res.status} ${res.statusText}${text ? ` · ${text.slice(0, 200)}` : ''}`,
      res.status,
    );
  }
  // Content-Length: 0 (empty body) just returns undefined typed as T.
  if (res.status === 204 || res.headers.get('Content-Length') === '0') {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Build the SSE URL with the token in the query string —
 *  EventSource can't carry custom headers. */
export function sseUrl(auth: MobileAuth, path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${auth.baseUrl}${path}${sep}token=${encodeURIComponent(auth.token)}`;
}
