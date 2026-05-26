/**
 * Jarvis Meet Detector — background service worker.
 *
 * Receives "meeting detected" events from the content script(s) and
 * POSTs them to the local Jarvis HTTP API. The Mac fires its existing
 * heads-up prompt ("record this meeting?") off the same flow as the
 * macOS Core Audio watcher — we just give it more reliable signal
 * for browser-hosted meetings.
 *
 * Settings stored in chrome.storage.local:
 *   baseUrl  — Jarvis HTTP API origin (e.g. http://127.0.0.1:4747)
 *   token    — bearer token from Settings → API → Token
 *
 * Both are set from popup.html. The extension is no-op until both
 * exist (no annoying notifications-please toast on every page).
 */

const STATE_KEY = 'jarvis.state';

/**
 * One detection per (tabId, vendor, ~minute) to avoid spamming when
 * the content script re-detects on URL changes. The Mac side also
 * dedupes by minute, so this is belt-and-suspenders.
 */
const recentSends = new Map(); // key → ts

function dedupeKey(tabId, vendor) {
  return `${tabId}:${vendor}:${Math.floor(Date.now() / 60_000)}`;
}

async function getSettings() {
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  return {
    baseUrl: typeof state.baseUrl === 'string' ? state.baseUrl.trim() : '',
    token: typeof state.token === 'string' ? state.token.trim() : '',
  };
}

async function sendMeetingEnded(payload) {
  const { baseUrl, token } = await getSettings();
  if (!baseUrl || !token) {
    return { ok: false, reason: 'not-configured' };
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/meeting/ended`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        vendor: payload.vendor,
        url: payload.url,
      }),
    });
    if (!res.ok) {
      return { ok: false, reason: `http-${res.status}` };
    }
    console.log('[jarvis-ext] meeting-ended sent', payload);
    return { ok: true };
  } catch (err) {
    console.warn('[jarvis-ext] meeting-ended send failed', err);
    return { ok: false, reason: 'network' };
  }
}

async function sendDetection(detection, tabId) {
  const { baseUrl, token } = await getSettings();
  if (!baseUrl || !token) {
    console.warn(
      '[jarvis-ext] not configured — open the popup and paste your Jarvis URL + token.',
    );
    return { ok: false, reason: 'not-configured' };
  }
  const key = dedupeKey(tabId ?? -1, detection.vendor ?? 'unknown');
  if (recentSends.has(key)) {
    return { ok: false, reason: 'deduped' };
  }
  recentSends.set(key, Date.now());
  // Trim the map periodically so it doesn't grow forever.
  if (recentSends.size > 100) {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [k, ts] of recentSends) if (ts < cutoff) recentSends.delete(k);
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/meeting/detected`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: 'extension',
        vendor: detection.vendor,
        title: detection.title,
        url: detection.url,
      }),
    });
    if (!res.ok) {
      console.warn(
        `[jarvis-ext] Jarvis rejected detection: ${res.status} ${res.statusText}`,
      );
      return { ok: false, reason: `http-${res.status}` };
    }
    console.log('[jarvis-ext] detection sent', detection);
    return { ok: true };
  } catch (err) {
    console.warn('[jarvis-ext] send failed', err);
    return { ok: false, reason: 'network' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === 'meeting-detected') {
    sendDetection(msg.payload, sender.tab?.id).then(sendResponse);
    return true; // async response
  }
  if (msg && msg.kind === 'meeting-ended') {
    sendMeetingEnded(msg.payload ?? {}).then(sendResponse);
    return true;
  }
  if (msg && msg.kind === 'ping-jarvis') {
    // Used by the popup's "Test connection" button — verifies the
    // URL + token round-trip without firing a real detection.
    (async () => {
      const { baseUrl, token } = await getSettings();
      if (!baseUrl || !token) {
        sendResponse({ ok: false, reason: 'not-configured' });
        return;
      }
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/status`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        sendResponse({
          ok: res.ok,
          status: res.status,
          ...(res.ok ? { json: await res.json() } : {}),
        });
      } catch (err) {
        sendResponse({
          ok: false,
          reason: err instanceof Error ? err.message : 'network',
        });
      }
    })();
    return true;
  }
  return false;
});
