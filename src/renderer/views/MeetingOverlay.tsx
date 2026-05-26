import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SkillSummary } from '../../shared/types';
import {
  meetingRecorder,
  type MeetingState,
} from '../voice/MeetingRecorder';
import { toast } from './Toaster';

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
  /** Currently-selected text inside the transcript (null when no selection). */
  const [selection, setSelection] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  useEffect(() => {
    void window.jarvis.listSkills().then(setSkills);
    return window.jarvis.onSkillsChanged(setSkills);
  }, []);

  // Listen for selection changes inside the transcript. When the user
  // releases the mouse with a non-empty selection, surface a floating
  // "act on this" button anchored to the selection's bottom-right.
  const checkSelection = useCallback(() => {
    const root = transcriptRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelection(null);
      setPickerOpen(false);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      // Selection is outside the transcript — ignore.
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      setSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    setSelection({ text, x: rect.right, y: rect.bottom });
    setPickerOpen(false);
  }, []);

  useEffect(() => {
    document.addEventListener('selectionchange', checkSelection);
    return () => document.removeEventListener('selectionchange', checkSelection);
  }, [checkSelection]);

  const dispatchToSkill = async (skill: SkillSummary) => {
    if (!selection) return;
    const transcriptSoFar = state.liveChunks.map((c) => c.text).join(' ');
    const prompt =
      `[MEETING SELECTION]\nFrom meeting "${state.title ?? 'untitled'}" (currently recording).\n\n` +
      `### Highlighted excerpt\n${selection.text}\n\n` +
      `### Full transcript so far (for context, may be partial)\n${transcriptSoFar || '_(no other speech yet)_'}\n\n` +
      `Act on the highlighted excerpt as the skill instructs.`;
    try {
      const t = await window.jarvis.launchTask({
        prompt,
        skillId: skill.id,
        origin: 'palette',
      });
      void window.jarvis.showAnswerHud(t.id);
      toast({ message: `Working on it · ${skill.name}` });
      // Clear selection so the action button doesn't linger.
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      setPickerOpen(false);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

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
    const offStart = window.jarvis.onMeetingStart(({ title, project }) => {
      void meetingRecorder.start(title, project ?? null);
    });
    const offStopReq = window.jarvis.onMeetingStopRequest(() => {
      void meetingRecorder.stop();
    });
    // Remote control from the mobile PWA — HTTP POST to
    // /v1/meeting/control routes here via broadcast IPC. We
    // dispatch to the same MeetingRecorder methods the local
    // overlay buttons call, so the behaviour stays identical.
    const offRemote = window.jarvis.onMeetingControlRemote(({ action }) => {
      switch (action) {
        case 'pause':
          meetingRecorder.pause();
          break;
        case 'resume':
          meetingRecorder.resume();
          break;
        case 'cancel':
          meetingRecorder.cancel();
          break;
        case 'finish':
          void meetingRecorder.stop();
          break;
      }
    });
    return () => {
      offStart();
      offStopReq();
      offRemote();
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
          <div
            className={`meeting-overlay__header${state.paused ? ' meeting-overlay__header--paused' : ''}`}
          >
            <span
              className={`meeting-overlay__dot${state.paused ? ' meeting-overlay__dot--paused' : ''}`}
            />
            <div className="meeting-overlay__body">
              <div className="meeting-overlay__title">
                {state.project && (
                  <span className="meeting-overlay__project">
                    {state.project} ·{' '}
                  </span>
                )}
                {state.title}
              </div>
              <div className="meeting-overlay__time">
                {(() => {
                  // Elapsed audible time = wall clock since start
                  // minus the cumulative paused gap, frozen on the
                  // value at pauseStart while still paused so the
                  // user sees the clock literally stop ticking.
                  const elapsed = state.paused && state.pausedAt != null
                    ? state.pausedAt - state.startedAt - state.pausedTotalMs
                    : now - state.startedAt - state.pausedTotalMs;
                  return state.paused
                    ? `PAUSED · ${formatDuration(Math.max(0, elapsed))}`
                    : `REC · ${formatDuration(Math.max(0, elapsed))}`;
                })()}
                {state.transcribing && !state.paused && (
                  <span className="meeting-overlay__pulse"> · ✦</span>
                )}
              </div>
            </div>
            <button
              className="meeting-overlay__toggle"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Collapse transcript' : 'Show live transcript'}
            >
              {expanded ? '▾' : '▸'}
            </button>
            {state.paused ? (
              <button
                className="meeting-overlay__resume"
                onClick={() => meetingRecorder.resume()}
                title="Resume recording"
              >
                ▶ Resume
              </button>
            ) : (
              <button
                className="meeting-overlay__pause"
                onClick={() => meetingRecorder.pause()}
                title="Pause — mic stays open, samples are dropped"
              >
                ❚❚ Pause
              </button>
            )}
            <button
              className="meeting-overlay__cancel"
              onClick={() => {
                if (
                  confirm(
                    'Discard this recording? No transcript will be saved.',
                  )
                ) {
                  meetingRecorder.cancel();
                }
              }}
              title="Discard recording — no transcript saved"
            >
              ✕
            </button>
            <button
              className="meeting-overlay__stop"
              onClick={() => void meetingRecorder.stop()}
              title="Stop + transcribe + save"
            >
              Finish
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
          {expanded && <LiveContextSidecar active={state.active} />}
          {expanded && selection && (
            <SelectionAction
              anchor={selection}
              skills={skills}
              open={pickerOpen}
              onOpen={() => setPickerOpen(true)}
              onPick={(s) => void dispatchToSkill(s)}
              onCancel={() => {
                setPickerOpen(false);
                window.getSelection()?.removeAllRanges();
                setSelection(null);
              }}
            />
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

interface SelectionActionProps {
  anchor: { text: string; x: number; y: number };
  skills: SkillSummary[];
  open: boolean;
  onOpen: () => void;
  onPick: (skill: SkillSummary) => void;
  onCancel: () => void;
}

/**
 * Floating "act on this" affordance anchored to the bottom-right of the
 * current transcript selection. Click → expands to a skill picker. Picking
 * a skill fires it with the highlighted text + transcript context.
 *
 * Positioning is in viewport coords (position: fixed) since the user can
 * scroll inside the transcript panel.
 */
function SelectionAction({
  anchor,
  skills,
  open,
  onOpen,
  onPick,
  onCancel,
}: SelectionActionProps) {
  // Clamp so the picker doesn't fall off-screen if the selection is near
  // the right edge.
  const x = Math.min(anchor.x, window.innerWidth - 280);
  const y = Math.min(anchor.y + 6, window.innerHeight - 320);
  const visibleSkills = skills
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div
      className="meeting-selection"
      style={{ left: `${x}px`, top: `${y}px` }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {!open ? (
        <div className="meeting-selection__buttons">
          <button
            className="meeting-selection__btn meeting-selection__btn--primary"
            onClick={onOpen}
          >
            ⚡ Act on selection
          </button>
          <button className="meeting-selection__btn" onClick={onCancel}>
            ×
          </button>
        </div>
      ) : (
        <div className="meeting-selection__picker">
          <header>Pick a skill</header>
          <ul>
            {visibleSkills.map((s) => (
              <li key={s.id}>
                <button onClick={() => onPick(s)}>
                  <span className="meeting-selection__skill-name">{s.name}</span>
                  {s.description && (
                    <span className="meeting-selection__skill-desc">
                      {s.description}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {visibleSkills.length === 0 && (
              <li className="meeting-selection__empty">No skills available.</li>
            )}
          </ul>
          <footer>
            <button onClick={onCancel}>cancel</button>
          </footer>
        </div>
      )}
    </div>
  );
}

interface ContextItem {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  url?: string;
  trigger?: string;
}

interface ContextSnapshot {
  meetingTitle?: string;
  updatedAt: number;
  items: ContextItem[];
}

/**
 * Sidecar panel showing entities the meeting-context-watch skill
 * surfaced from the recent transcript window. Polls main every
 * 10s while recording — light enough that the polling doesn't
 * matter cost-wise, and matches the human "every minute or so I
 * want fresh context" expectation without coupling to the skill's
 * exact 60s tick.
 *
 * Stale snapshots (older than 5 min) hide instead of showing
 * outdated items — happens when the skill silently failed for a
 * stretch.
 */
function LiveContextSidecar({ active }: { active: boolean }) {
  const [snap, setSnap] = useState<ContextSnapshot | null>(null);

  useEffect(() => {
    if (!active) {
      setSnap(null);
      return;
    }
    let cancelled = false;
    const fetch = async (): Promise<void> => {
      try {
        const next = await window.jarvis.readMeetingLiveContext();
        if (!cancelled) setSnap(next ?? null);
      } catch {
        /* polling, ignore transient errors */
      }
    };
    void fetch();
    const id = setInterval(() => void fetch(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);

  if (!snap || snap.items.length === 0) return null;
  // Drop stale snapshots — older than 5 min means the skill went
  // quiet (failed / no recent transcript content).
  if (Date.now() - snap.updatedAt > 5 * 60_000) return null;

  const open = (url: string | undefined): void => {
    if (!url) return;
    void window.jarvis.openExternal(url);
  };

  return (
    <div className="meeting-overlay__context">
      <div className="meeting-overlay__context-head">
        <span className="meeting-overlay__context-dot" aria-hidden>
          ◆
        </span>
        Live context
      </div>
      <ul className="meeting-overlay__context-list">
        {snap.items.map((it) => (
          <li key={it.id} className="meeting-overlay__context-item">
            <button
              type="button"
              className="meeting-overlay__context-row"
              onClick={() => open(it.url)}
              title={it.url ?? ''}
              disabled={!it.url}
            >
              <span className={`meeting-overlay__context-kind kind-${it.kind}`}>
                {kindGlyph(it.kind)}
              </span>
              <span className="meeting-overlay__context-text">
                <span className="meeting-overlay__context-title">{it.title}</span>
                {it.subtitle && (
                  <span className="meeting-overlay__context-sub">
                    {it.subtitle}
                  </span>
                )}
              </span>
            </button>
            {it.trigger && (
              <span className="meeting-overlay__context-trigger">
                ↪ &ldquo;{it.trigger}&rdquo;
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function kindGlyph(kind: string): string {
  switch (kind) {
    case 'pr':
      return '⎇';
    case 'linear':
      return '▣';
    case 'notion':
      return '✎';
    case 'meeting':
      return '◑';
    case 'file':
      return '◾';
    case 'person':
      return '◉';
    default:
      return '·';
  }
}
