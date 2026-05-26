/**
 * Jarvis Meet Detector — content script.
 *
 * Runs on Meet/Zoom/Teams/Whereby pages. Detects when the user has
 * actually JOINED a call (vs sitting on a landing/lobby page) and
 * pings the background worker once. The vendor heuristics are
 * deliberately conservative — false positives nag the user with a
 * heads-up; false negatives just mean they manually /meeting.
 *
 * Detection strategies, in order of trust:
 *
 *   - Meet (meet.google.com):
 *       URL pattern is `meet.google.com/<3-letter>-<4-letter>-<3-letter>`
 *       when in a room (vs `/meet.google.com/landing`). The page also
 *       exposes `aria-label` controls like "Leave call" when joined.
 *
 *   - Zoom (*.zoom.us):
 *       The web client URL changes to `/wc/<id>/start` and renders a
 *       toolbar with a "Leave" button.
 *
 *   - Teams (teams.microsoft.com / teams.live.com):
 *       In-call surface has `data-tid="hangup-button"` or similar.
 *
 *   - Whereby (whereby.com):
 *       Rooms are subpaths `/<room>`; sit in lobby briefly, then DOM
 *       carries `<button aria-label="Leave room">`.
 *
 * We poll the DOM every 2s for the first 30s after page load + on
 * every history-state change (SPA navigations). Once we detect a
 * join we mark this tab "in meeting" and stop polling (the dedupe
 * in background.js handles re-pings).
 */

(() => {
  const VENDOR = pickVendor(location.hostname);
  if (!VENDOR) return;

  const POLL_MS = 2_000;
  const POLL_WINDOW_MS = 60_000;
  /** How long the "leave" indicator must be absent before we declare
   *  the meeting ended. Stops false positives during DOM rerenders
   *  (Meet, in particular, briefly removes its toolbar during layout
   *  changes). */
  const LEFT_DEBOUNCE_MS = 6_000;
  let polledFor = 0;
  let detected = false;
  let pollTimer = null;
  let endedSent = false;
  let leftSince = 0;

  function pickVendor(host) {
    if (host.endsWith('meet.google.com')) return 'meet';
    if (host.endsWith('.zoom.us')) return 'zoom';
    if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com'))
      return 'teams';
    if (host.endsWith('whereby.com')) return 'whereby';
    return null;
  }

  function isInCall() {
    switch (VENDOR) {
      case 'meet':
        // Meet rooms have the form abc-defg-hij. Pre-join lobby uses
        // the same URL but doesn't have a "Leave call" button yet.
        if (!/\/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}/.test(location.pathname)) {
          return false;
        }
        return Boolean(
          document.querySelector(
            '[aria-label*="Leave call" i],[aria-label*="Quitter l’appel" i]',
          ),
        );
      case 'zoom':
        // Web client in-call: `/wc/<id>/start`. Toolbar buttons appear
        // once the join completes.
        return (
          /\/wc\/\d+\/start/.test(location.pathname) ||
          Boolean(document.querySelector('[aria-label*="Leave" i]'))
        );
      case 'teams':
        return Boolean(
          document.querySelector(
            '[data-tid="hangup-button"], [data-tid="hangup-main-btn"]',
          ),
        );
      case 'whereby':
        return Boolean(
          document.querySelector('[aria-label*="Leave room" i]'),
        );
      default:
        return false;
    }
  }

  function readTitle() {
    switch (VENDOR) {
      case 'meet': {
        // Meet shows "Meeting details" in the title; the actual meeting
        // name lives in <title> as "<name> - Google Meet".
        const m = document.title.match(/^(.+?)\s*[-|–]\s*Google Meet/);
        return m ? m[1].trim() : null;
      }
      case 'zoom': {
        const m = document.title.match(/^(.+?)\s*[-|–]\s*Zoom/);
        return m ? m[1].trim() : null;
      }
      case 'teams': {
        const m = document.title.match(/^(.+?)\s*\|/);
        return m ? m[1].trim() : null;
      }
      case 'whereby':
        return document.title.replace(/\s*\|\s*Whereby.*$/, '').trim() || null;
      default:
        return document.title || null;
    }
  }

  function ping() {
    if (detected) return;
    detected = true;
    // Keep polling AFTER the join ping fires — we now also need to
    // watch for the leave transition. Switch the poll interval down
    // to a slower cadence to avoid wasting CPU during the call.
    restartPolling(5_000);
    chrome.runtime.sendMessage(
      {
        kind: 'meeting-detected',
        payload: {
          vendor: VENDOR,
          title: readTitle(),
          url: location.href,
        },
      },
      (res) => {
        if (!res?.ok) {
          // Reset so a later real detection on the same tab still
          // pings (e.g. lobby → joined transition). The bg-side
          // minute-bucket dedupe keeps things sane.
          if (res?.reason === 'not-configured') return;
          detected = false;
        }
      },
    );
  }

  function pingEnded() {
    if (endedSent) return;
    endedSent = true;
    stopPolling();
    chrome.runtime.sendMessage(
      {
        kind: 'meeting-ended',
        payload: { vendor: VENDOR, url: location.href },
      },
      () => {
        // Fire-and-forget — Jarvis silently ignores if there's
        // nothing to stop.
      },
    );
  }

  function poll() {
    polledFor += POLL_MS;
    const inCall = isInCall();
    if (!detected) {
      if (inCall) {
        ping();
        return;
      }
      if (polledFor >= POLL_WINDOW_MS) {
        stopPolling();
      }
      return;
    }
    // detected === true → watch for leave transition.
    if (inCall) {
      // Still in. Reset the debounce timer.
      leftSince = 0;
      return;
    }
    const now = Date.now();
    if (leftSince === 0) {
      leftSince = now;
      return;
    }
    if (now - leftSince >= LEFT_DEBOUNCE_MS) {
      pingEnded();
    }
  }

  function startPolling() {
    if (pollTimer) return;
    polledFor = 0;
    pollTimer = setInterval(poll, POLL_MS);
    // Fast-path: check immediately so the first detection isn't
    // delayed by a full POLL_MS.
    setTimeout(poll, 200);
  }

  function restartPolling(intervalMs) {
    stopPolling();
    pollTimer = setInterval(poll, intervalMs);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // SPA-friendly: rebind on navigation (Meet + Teams swap URLs without
  // a full reload when entering a call).
  const restart = () => {
    detected = false;
    endedSent = false;
    leftSince = 0;
    startPolling();
  };
  window.addEventListener('popstate', restart);
  const origPush = history.pushState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    restart();
    return r;
  };

  startPolling();
})();
