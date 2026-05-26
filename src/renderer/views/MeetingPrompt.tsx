import { useEffect, useRef, useState } from 'react';

import type { AppMode, InboxItem } from '../../shared/types';
import { toast } from './Toaster';

const AUTOPILOT_COUNTDOWN_MS = 5_000;

interface PendingPrompt {
  item: InboxItem;
  minutesUntil: number;
  /** Local id to ignore duplicates while a prompt is still on screen. */
  shownAt: number;
}

/**
 * "Your meeting is starting — want to record it?" toast.
 *
 * Fires when InboxProximityWatcher (main) detects a calendar item /
 * meeting-URL item is within 2 minutes of starting. Shows a small
 * non-modal card at top-right with three actions:
 *
 *   [Record]  — fires the meeting-recorder /start intent with the
 *               item's title (and project alias if the title carries
 *               an "alias:" prefix, same shape as /meeting input).
 *   [Join]    — opens the meeting URL (Meet/Zoom/Teams) without
 *               recording. Only shown when item.url is set.
 *   [Skip]    — dismisses + tells main to suppress further prompts
 *               for this item.
 *
 * Auto-dismisses after 90 seconds if the user does nothing — so a
 * forgotten prompt doesn't sit on screen forever.
 */
export function MeetingPrompt() {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  // Autopilot mode = auto-start recording after a visible countdown.
  // Tracked in a ref so the auto-trigger effect can read the live
  // value without re-binding when only the mode changes.
  const [appMode, setAppMode] = useState<AppMode>('running');
  const cancelledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.getAppMode().then((m) => {
      if (!cancelled) setAppMode(m);
    });
    const off = window.jarvis.onAppModeChanged((m) => setAppMode(m));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    return window.jarvis.onMeetingImminent(({ item, minutesUntil }) => {
      setPending({ item, minutesUntil, shownAt: Date.now() });
    });
  }, []);

  // Auto-dismiss after 90s so it doesn't linger.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 90_000);
    return () => clearTimeout(t);
  }, [pending]);

  // Autopilot: auto-Record after a short visible countdown. The
  // user can still cancel by clicking Skip or ✕ during the window.
  useEffect(() => {
    if (!pending) return;
    if (appMode !== 'autopilot') return;
    if (cancelledRef.current.has(pending.item.id)) return;
    const t = setTimeout(() => {
      // Re-read state at fire time so an in-flight Skip during the
      // countdown still wins.
      if (cancelledRef.current.has(pending.item.id)) return;
      void startRecording();
    }, AUTOPILOT_COUNTDOWN_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.item.id, appMode]);

  if (!pending) return null;

  const { item, minutesUntil } = pending;

  const startRecording = async () => {
    try {
      const result = await window.jarvis.dispatchIntent(
        'meeting-recorder',
        'start',
        item.title || 'Meeting',
      );
      if (result.ok) {
        toast({ message: result.message ?? `Recording · ${item.title}` });
      } else {
        toast({ kind: 'error', message: result.message ?? 'Failed to start recording' });
      }
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPending(null);
    }
  };

  const join = () => {
    if (!item.url) return;
    void window.jarvis.openExternal(item.url);
    setPending(null);
  };

  const skip = () => {
    cancelledRef.current.add(item.id);
    void window.jarvis.suppressMeetingPrompt(item.id);
    setPending(null);
  };

  /** "Don't ask for the next hour" — useful during focus blocks
   *  where you DON'T want a heads-up every time you tap the mic.
   *  RAM-only on the Mac side; restart clears. */
  const snooze1h = () => {
    cancelledRef.current.add(item.id);
    void window.jarvis.snoozeMeetingHeadsUp(60 * 60_000);
    toast({ message: 'Meeting prompts snoozed 1h' });
    setPending(null);
  };

  // Ad-hoc detections (mic/cam went hot at the OS level) come through
  // with minutesUntil=0 and an "ad-hoc-…" id; treat them as "already in
  // progress" rather than "starting in 0 min".
  const adHoc = item.id.startsWith('ad-hoc-');
  const timeLabel = adHoc
    ? 'in progress'
    : minutesUntil <= 1
    ? 'starting now'
    : `in ${minutesUntil} min`;

  return (
    <div className="meeting-prompt" role="dialog" aria-live="polite">
      <div className="meeting-prompt__head">
        <span className="meeting-prompt__pulse" aria-hidden />
        <span className="meeting-prompt__label">Meeting {timeLabel}</span>
        <button
          className="meeting-prompt__close"
          onClick={skip}
          title="Dismiss + don't prompt again for this meeting"
          aria-label="Skip"
        >
          ✕
        </button>
      </div>
      <div className="meeting-prompt__title" title={item.title}>
        {item.title}
      </div>
      {item.subtitle && (
        <div className="meeting-prompt__sub">{item.subtitle}</div>
      )}
      <div className="meeting-prompt__actions">
        <button
          className="meeting-prompt__primary"
          onClick={() => void startRecording()}
        >
          🎙 Record
        </button>
        {item.url && (
          <button className="meeting-prompt__join" onClick={join}>
            Join
          </button>
        )}
        <button className="meeting-prompt__skip" onClick={skip}>
          Skip
        </button>
        <button
          className="meeting-prompt__snooze"
          onClick={snooze1h}
          title="Silence meeting heads-ups for the next hour"
        >
          Snooze 1h
        </button>
      </div>
    </div>
  );
}
