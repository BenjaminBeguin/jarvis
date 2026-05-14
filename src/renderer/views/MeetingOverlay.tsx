import { useEffect, useMemo, useRef, useState } from 'react';

import {
  meetingRecorder,
  type MeetingState,
} from '../voice/MeetingRecorder';

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Listen for /meeting palette intents firing in the main process and route
 * them into the renderer-side MeetingRecorder. Renders a floating overlay
 * with the running duration + a Stop button while a recording is active,
 * or while the post-stop transcribe + save is finishing.
 */
export function MeetingOverlay() {
  const [state, setState] = useState<MeetingState>(meetingRecorder.getState());
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Concatenate chunks for a flowing transcript; preserve breaks every
  // few chunks so the eye gets paragraph anchors.
  const liveText = useMemo(
    () => state.liveChunks.map((c) => c.text).join(' '),
    [state.liveChunks],
  );

  // Auto-scroll to bottom as new chunks come in, unless the user has
  // scrolled up to read older content.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || !expanded) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [liveText, expanded]);

  useEffect(() => {
    const unsub = meetingRecorder.subscribe(setState);
    return unsub;
  }, []);

  useEffect(() => {
    const offStart = window.jarvis.onMeetingStart(({ title }) => {
      void meetingRecorder.start(title);
    });
    const offStopReq = window.jarvis.onMeetingStopRequest(() => {
      void meetingRecorder.stop();
    });
    return () => {
      offStart();
      offStopReq();
    };
  }, []);

  useEffect(() => {
    if (!state.active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.active]);

  // Auto-dismiss errors after a few seconds so they don't sit forever.
  useEffect(() => {
    if (!state.error) return;
    const t = setTimeout(() => {
      const s = meetingRecorder.getState();
      if (s.error) {
        // Manually clear by transitioning to an idle state.
        meetingRecorder.abort();
      }
    }, 6000);
    return () => clearTimeout(t);
  }, [state.error]);

  if (!state.active && !state.finishing && !state.error) return null;

  return (
    <div className={`meeting-overlay${expanded ? ' meeting-overlay--expanded' : ''}`}>
      {state.active && state.startedAt !== null && (
        <>
          <div className="meeting-overlay__header">
            <span className="meeting-overlay__dot" />
            <div className="meeting-overlay__body">
              <div className="meeting-overlay__title">{state.title}</div>
              <div className="meeting-overlay__time">
                REC · {formatDuration(now - state.startedAt)}
                {state.transcribing && <span className="meeting-overlay__pulse"> · ✦</span>}
              </div>
            </div>
            <button
              className="meeting-overlay__toggle"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Collapse transcript' : 'Show live transcript'}
            >
              {expanded ? '▾' : '▸'}
            </button>
            <button
              className="meeting-overlay__stop"
              onClick={() => void meetingRecorder.stop()}
            >
              Stop
            </button>
          </div>
          {expanded && (
            <div className="meeting-overlay__transcript" ref={transcriptRef}>
              {liveText ? (
                liveText
              ) : (
                <span className="meeting-overlay__placeholder">
                  Listening… first chunk transcribes after ~5s of speech.
                </span>
              )}
            </div>
          )}
        </>
      )}
      {state.finishing && (
        <div className="meeting-overlay__finishing">
          Transcribing meeting…
        </div>
      )}
      {state.error && !state.active && !state.finishing && (
        <div className="meeting-overlay__error">{state.error}</div>
      )}
    </div>
  );
}
