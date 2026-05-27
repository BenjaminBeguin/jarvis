/**
 * Jarvis Meet Detector — background service worker.
 *
 * Receives "meeting detected" + "meeting ended" events from the
 * content script(s) and POSTs them to the local Jarvis HTTP API.
 * The Mac fires its existing heads-up prompt ("record this
 * meeting?") off the same flow as the macOS Core Audio watcher.
 *
 * Settings stored in chrome.storage.local:
 *   baseUrl  — Jarvis HTTP API origin (e.g. http://127.0.0.1:4747)
 *   token    — bearer token from Settings → API → Token
 *
 * In-meeting tab state stored in chrome.storage.session (cleared on
 * browser quit, survives SW hibernation):
 *   inMeetingTabs — { [tabId]: { vendor, url } }
 *
 * Tab-close detection: MV3 service workers can hibernate, but
 * `chrome.tabs.onRemoved` is registered at the top level so it wakes
 * the worker when a tab closes. If the closed tab was in our
 * in-meeting map, we fire meeting-ended — the content script
 * couldn't, because it died with the page.
 */

const STATE_KEY = 'jarvis.state';
const TABS_KEY = 'jarvis.inMeetingTabs';
const ACTIVITY_KEY = 'jarvis.lastActivitySend';

/**
 * How often we'll re-send the active tab even if the user hasn't
 * switched. Keeps Jarvis's "currently viewing" context fresh without
 * spamming the HTTP endpoint when the user is on a single page.
 */
const ACTIVITY_HEARTBEAT_MS = 90_000;

/**
 * Per-tab dedupe — the same URL won't fire activity events more
 * often than this. Stops `chrome.tabs.onUpdated` from spamming on
 * SPAs that fire many status='complete' transitions during load.
 */
const ACTIVITY_DEBOUNCE_MS = 5_000;

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

async function getInMeetingTabs() {
  const { [TABS_KEY]: tabs = {} } =
    await chrome.storage.session.get(TABS_KEY);
  return tabs;
}

async function setInMeetingTabs(tabs) {
  await chrome.storage.session.set({ [TABS_KEY]: tabs });
}

async function markTabInMeeting(tabId, payload) {
  if (typeof tabId !== 'number') return;
  const tabs = await getInMeetingTabs();
  tabs[tabId] = {
    vendor: payload.vendor ?? null,
    url: payload.url ?? null,
    at: Date.now(),
  };
  await setInMeetingTabs(tabs);
}

async function clearTabInMeeting(tabId) {
  if (typeof tabId !== 'number') return null;
  const tabs = await getInMeetingTabs();
  const prev = tabs[tabId];
  if (!prev) return null;
  delete tabs[tabId];
  await setInMeetingTabs(tabs);
  return prev;
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
    (async () => {
      const result = await sendDetection(msg.payload, sender.tab?.id);
      // Remember the tab so tabs.onRemoved can fire meeting-ended
      // when the user closes the tab without first leaving the call.
      if (result.ok && sender.tab?.id != null) {
        await markTabInMeeting(sender.tab.id, msg.payload);
      }
      sendResponse(result);
    })();
    return true; // async response
  }
  if (msg && msg.kind === 'meeting-ended') {
    (async () => {
      const result = await sendMeetingEnded(msg.payload ?? {});
      // Forget the tab — even if the send failed (Jarvis offline,
      // 401, etc.) the content script told us the user left, so
      // tabs.onRemoved shouldn't double-fire later.
      if (sender.tab?.id != null) {
        await clearTabInMeeting(sender.tab.id);
      }
      sendResponse(result);
    })();
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

/**
 * Tab close → fire meeting-ended if we previously saw a detection on
 * that tab. The content script can't notify us itself because it dies
 * with the page. Registered at the top level so it wakes the SW from
 * hibernation when a tab closes.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const prev = await clearTabInMeeting(tabId);
  if (!prev) return;
  console.log(
    '[jarvis-ext] tab closed while in meeting — firing meeting-ended',
    prev,
  );
  await sendMeetingEnded({ vendor: prev.vendor, url: prev.url });
});

/**
 * Tab navigation away from meeting URL → also fire meeting-ended.
 * The content script only re-runs when the new URL matches a meeting
 * host; if the user navigates to gmail.com, the content script is
 * gone but the tab isn't.
 *
 * We use a generous heuristic: any time the URL on a known
 * in-meeting tab changes to one that doesn't look like the same
 * vendor's meeting page, treat it as the user leaving.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const tabs = await getInMeetingTabs();
  const prev = tabs[tabId];
  if (!prev) return;
  if (urlMatchesVendor(changeInfo.url, prev.vendor)) return;
  // Navigated away from the meeting page. Treat as leave.
  delete tabs[tabId];
  await setInMeetingTabs(tabs);
  console.log(
    '[jarvis-ext] tab navigated away from meeting — firing meeting-ended',
    { tabId, oldUrl: prev.url, newUrl: changeInfo.url },
  );
  await sendMeetingEnded({ vendor: prev.vendor, url: prev.url });
});

// ─── Active-tab reporting ──────────────────────────────────────────
//
// On tab activation, URL change, or window focus, POST the active
// tab's URL + title to Jarvis. The Mac uses this as ambient context
// in every Claude turn — so when the user asks "summarise this" or
// "what should I do next", the agent already knows which PR / Linear
// ticket / Slack channel they were just looking at.
//
// User-controlled via the Settings → Modules → Browser panel on the
// Mac. Settings stored in chrome.storage.local:
//   activityTracking: 'off' | 'on'   (default 'off' — opt-in)
//   activityExcludes: string[]       (substring matches against URL;
//                                     anything matching is dropped
//                                     before sending. Defaults to
//                                     common-sensitive: bank, finance,
//                                     health, etc.)

async function getActivitySettings() {
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  return {
    tracking: state.activityTracking === 'on',
    excludes: Array.isArray(state.activityExcludes) ? state.activityExcludes : [],
  };
}

const lastSent = new Map(); // tabId → { url, sentAt }

async function reportActiveTab(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) return;
  const { tracking, excludes } = await getActivitySettings();
  if (!tracking) return;
  const lc = tab.url.toLowerCase();
  if (excludes.some((needle) => needle && lc.includes(String(needle).toLowerCase()))) {
    return;
  }
  const now = Date.now();
  const prev = lastSent.get(tab.id);
  if (
    prev &&
    prev.url === tab.url &&
    now - prev.sentAt < ACTIVITY_DEBOUNCE_MS
  ) {
    return;
  }
  lastSent.set(tab.id, { url: tab.url, sentAt: now });
  const { baseUrl, token } = await getSettings();
  if (!baseUrl || !token) return;
  try {
    await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/browser/activity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: tab.url,
        title: typeof tab.title === 'string' ? tab.title : '',
        at: now,
      }),
    });
  } catch (err) {
    // Quiet fail — activity is best-effort.
    console.warn('[jarvis-ext] activity send failed', err);
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await reportActiveTab(tab);
  } catch {
    /* tab may have been closed between activation + get */
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return; // only fire on real navigations
  if (!tab.active) return;
  void reportActiveTab(tab);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await reportActiveTab(tab);
  } catch {
    /* window may have closed */
  }
});

// Heartbeat: even if the user sits on one page for a while, refresh
// Jarvis's "currently viewing" so it doesn't decay out of context.
// chrome.alarms wakes the SW from hibernation reliably (better than
// setInterval which dies with the worker).
chrome.alarms.create('activity-heartbeat', {
  periodInMinutes: ACTIVITY_HEARTBEAT_MS / 60_000,
});

// Settings sync: pull the user's activity-tracking preferences from
// Jarvis. The user flips the toggle in Settings → Modules → Browser
// (on the Mac) and the extension picks it up within ~1 min — no
// need to also edit the popup.
chrome.alarms.create('settings-sync', { periodInMinutes: 1 });

async function syncSettingsFromJarvis() {
  const { baseUrl, token } = await getSettings();
  if (!baseUrl || !token) return;
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/v1/browser/settings`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok) return;
    const body = await res.json();
    const { [STATE_KEY]: state = {} } =
      await chrome.storage.local.get(STATE_KEY);
    const next = {
      ...state,
      activityTracking: body.activityTracking === true ? 'on' : 'off',
      activityExcludes: Array.isArray(body.activityExcludes)
        ? body.activityExcludes
        : [],
    };
    await chrome.storage.local.set({ [STATE_KEY]: next });
  } catch {
    /* quiet — settings sync is best-effort */
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'activity-heartbeat') {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab) {
        // Bypass the per-tab debounce on heartbeat ticks so the
        // Mac always has a fresh-ish "currently viewing".
        lastSent.delete(tab.id);
        await reportActiveTab(tab);
      }
    } catch {
      /* no focused window */
    }
    return;
  }
  if (alarm.name === 'settings-sync') {
    await syncSettingsFromJarvis();
    return;
  }
});

// Pull settings immediately on SW boot too — alarms only fire after
// the periodInMinutes elapses, so without this the first minute
// after install / toggle-flip would use stale settings.
void syncSettingsFromJarvis();

function urlMatchesVendor(url, vendor) {
  try {
    const host = new URL(url).hostname;
    switch (vendor) {
      case 'meet':
        return host === 'meet.google.com';
      case 'zoom':
        return host.endsWith('.zoom.us');
      case 'teams':
        return (
          host === 'teams.microsoft.com' || host === 'teams.live.com'
        );
      case 'whereby':
        return host === 'whereby.com' || host.endsWith('.whereby.com');
      default:
        return false;
    }
  } catch {
    return false;
  }
}
