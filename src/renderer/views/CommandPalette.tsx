import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ModuleSummary,
  PaletteIntentSummary,
  SkillSummary,
  TranscribeProgress,
} from '../../shared/types';
import { AudioCapture } from '../voice/AudioCapture';

interface PendingIntent extends PaletteIntentSummary {}

function formatScheduleHint(fireAt: number): string {
  const diff = fireAt - Date.now();
  if (diff <= 0) return 'now';
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'in <1m';
  if (m < 60) return `in ${m}m`;
  const h = m / 60;
  if (h < 24) {
    const round = Math.round(h * 10) / 10;
    return Number.isInteger(round) ? `in ${round.toFixed(0)}h` : `in ${round}h`;
  }
  const target = new Date(fireAt);
  return target.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Whisper emits placeholder tokens when audio is silent/unintelligible.
 * Strip them. Also: Whisper notoriously hallucinates "Thank you." for silent
 * clips (it's all over its YouTube training data) — drop that, but only when
 * it's the entire utterance. Longer phrases that happen to contain "thank
 * you" are kept.
 */
function cleanTranscript(raw: string): string {
  const stripped = raw
    .replace(/\[\s*BLANK[_ ]AUDIO\s*\]/gi, '')
    .replace(/\[\s*INAUDIBLE\s*\]/gi, '')
    .replace(/\[\s*MUSIC\s*\]/gi, '')
    .replace(/\(\s*silence\s*\)/gi, '')
    .replace(/\(\s*music\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = stripped.toLowerCase().replace(/[.!?,;:'"-]+$/, '').trim();
  // Standalone hallucinations from silent or near-silent audio.
  if (normalized === '' || normalized === 'thank you' || normalized === 'you') {
    return '';
  }
  return stripped;
}

export function CommandPalette() {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<TranscribeProgress | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [activeSkill, setActiveSkill] = useState<SkillSummary | null>(null);
  const [activeIntent, setActiveIntent] = useState<PendingIntent | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Inline hint when the current text parses to a scheduled action/reminder. */
  const [schedulePreview, setSchedulePreview] = useState<{
    mode: 'reminder' | 'scheduled';
    fireAt: number;
  } | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.jarvis.listSkills().then(setSkills);
    void window.jarvis.listModules().then(setModules);
    const offS = window.jarvis.onSkillsChanged(setSkills);
    const offM = window.jarvis.onModulesChanged(setModules);
    const offP = window.jarvis.onTranscribeProgress((event) => {
      // Only render download/loading status while we're not idle.
      if (event.status === 'ready' || event.status === 'done') {
        setDownloadProgress(null);
      } else {
        setDownloadProgress(event);
      }
    });
    return () => {
      offS();
      offM();
      offP();
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Resize the palette window to fit its content. ResizeObserver fires
  // whenever the picker opens/closes, error appears, mic-progress shows,
  // etc. — the window grows and shrinks in lockstep, so there's no big
  // invisible-but-clickable empty area below the input.
  useEffect(() => {
    const el = paletteRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Add a hair of padding so a 1px rounding error doesn't clip
      // shadows or the bottom border of the picker.
      void window.jarvis.resizePalette(Math.ceil(rect.height) + 4);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const intents = useMemo<PaletteIntentSummary[]>(
    () => modules.flatMap((m) => m.intents),
    [modules],
  );

  // Debounced preview: when the user is typing free text (no skill, no
  // intent, no slash), ask main whether it would route as a reminder /
  // scheduled action. Show a subtle hint when yes — so the user sees the
  // schedule *before* hitting Enter.
  useEffect(() => {
    if (activeSkill || activeIntent || text.startsWith('/') || !text.trim()) {
      setSchedulePreview(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void window.jarvis.previewIntent(text).then((r) => {
        if (cancelled) return;
        if (r.kind === 'reminder') {
          setSchedulePreview({ mode: r.mode, fireAt: r.fireAt });
        } else {
          setSchedulePreview(null);
        }
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [text, activeSkill, activeIntent]);

  // If the user types a full intent prefix as the first word, promote it to
  // an active intent chip so Enter dispatches it (don't open the skill picker).
  useEffect(() => {
    if (activeIntent || activeSkill) return;
    if (!text.startsWith('/')) return;
    const firstSpace = text.indexOf(' ');
    if (firstSpace === -1) return;
    const prefix = text.slice(0, firstSpace);
    const match = intents.find((i) => i.prefix === prefix);
    if (match) {
      setActiveIntent(match);
      setText(text.slice(firstSpace + 1));
    }
  }, [text, intents, activeIntent, activeSkill]);

  const pickerOpen = text.startsWith('/') && !activeSkill && !activeIntent;
  const filter = pickerOpen ? text.slice(1).toLowerCase().trim() : '';

  type PickerRow =
    | { kind: 'intent'; value: PaletteIntentSummary }
    | { kind: 'skill'; value: SkillSummary };

  const matches = useMemo<PickerRow[]>(() => {
    if (!pickerOpen) return [];
    const tokens = filter.split(/\s+/).filter(Boolean);
    const score = (haystack: string): boolean => {
      if (tokens.length === 0) return true;
      const h = haystack.toLowerCase();
      return tokens.every((t) => h.includes(t));
    };
    const intentRows: PickerRow[] = intents
      .filter((i) => score(`${i.prefix} ${i.label} ${i.description ?? ''}`))
      .map((value) => ({ kind: 'intent', value }));
    const skillRows: PickerRow[] = skills
      .filter((s) => score(`${s.name} ${s.description}`))
      .map((value) => ({ kind: 'skill', value }));
    return [...intentRows, ...skillRows];
  }, [intents, skills, filter, pickerOpen]);

  useEffect(() => {
    if (pickerIndex >= matches.length) setPickerIndex(0);
  }, [matches.length, pickerIndex]);

  interface DispatchOverride {
    text?: string;
    intent?: PaletteIntentSummary | null;
    skill?: SkillSummary | null;
    origin?: 'palette' | 'voice';
  }

  const dispatch = async (override: DispatchOverride = {}) => {
    setError(null);
    const prompt = (override.text ?? text).trim();
    const intentForCall = override.intent !== undefined ? override.intent : activeIntent;
    const skillForCall = override.skill !== undefined ? override.skill : activeSkill;

    if (intentForCall) {
      try {
        const result = await window.jarvis.dispatchIntent(
          intentForCall.moduleId,
          intentForCall.id,
          prompt,
        );
        if (!result.ok) {
          setError(result.message ?? 'Intent failed');
          return;
        }
        setText('');
        setActiveIntent(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!prompt && !skillForCall) return;
    try {
      // Skill-pinned launches always go straight to the runner — the
      // intent router would just see the prompt body without knowing
      // about the skill.
      if (skillForCall) {
        const summary = await window.jarvis.launchTask({
          prompt: prompt || 'Begin.',
          skillId: skillForCall.id,
          origin: override.origin ?? 'palette',
        });
        setText('');
        setActiveSkill(null);
        void window.jarvis.showAnswerHud(summary.id);
        return;
      }
      // Free-text: let main classify ("remind me in 2h …" → reminder, else
      // task). Reminder confirmations show as a brief native notification;
      // tasks pop the HUD as before.
      const result = await window.jarvis.routePrompt(prompt, {
        origin: override.origin ?? 'palette',
      });
      setText('');
      if (result.kind === 'task') {
        void window.jarvis.showAnswerHud(result.task.id);
      }
      // For reminders: main fires its own notification; nothing more to do.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectRow = (row: PickerRow) => {
    if (row.kind === 'skill') {
      setActiveSkill(row.value);
      setText('');
    } else {
      setActiveIntent(row.value);
      setText('');
    }
    setPickerIndex(0);
    setError(null);
    inputRef.current?.focus();
  };

  const startVoice = async () => {
    if (captureRef.current || transcribing) return;
    setError(null);
    try {
      const perm = await window.jarvis.requestMicAccess();
      if (!perm.granted) {
        setError(
          perm.status === 'denied'
            ? 'Microphone denied. Enable in System Settings → Privacy → Microphone → Jarvis.'
            : `Microphone unavailable (status: ${perm.status}).`,
        );
        return;
      }
    } catch (e) {
      console.warn('mic permission probe failed', e);
    }

    const capture = new AudioCapture();
    try {
      await capture.start();
    } catch (e) {
      setError(`Mic open failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    captureRef.current = capture;
    setListening(true);
  };

  const stopVoice = async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    setListening(false);
    let result;
    try {
      result = await capture.stop();
    } catch (e) {
      setError(`Audio capture failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Less than ~0.3s of audio — almost certainly an accidental tap, not a
    // real utterance. Skip the round-trip.
    if (result.pcm.length < 16_000 * 0.3) {
      setError("Didn't hear anything — hold the mic button while speaking.");
      return;
    }
    setTranscribing(true);
    try {
      const raw = await window.jarvis.transcribe(result.pcm.buffer as ArrayBuffer);
      const transcript = cleanTranscript(raw);
      if (!transcript) {
        setError("Couldn't make out the audio. Try again with less background noise.");
        return;
      }
      await routeVoiceCommand(transcript);
    } catch (e) {
      setError(`Transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTranscribing(false);
    }
  };

  /**
   * Voice route. Priority:
   *   1. Active skill or intent → submit using that.
   *   2. First word matches a module intent prefix → route to that intent.
   *   3. Free-form → launch a new task.
   *
   * Voice replies to an existing task happen in the Answer HUD, not here.
   */
  const routeVoiceCommand = async (transcript: string) => {
    if (activeSkill) {
      setText(transcript);
      await dispatch({ text: transcript, origin: 'voice' });
      return;
    }
    if (activeIntent) {
      setText(transcript);
      await dispatch({ text: transcript, origin: 'voice' });
      return;
    }
    const tokens = transcript.split(/\s+/);
    const firstWord = (tokens[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const matchedIntent = intents.find(
      (i) => i.prefix === `/${firstWord}` || i.id === firstWord,
    );
    if (matchedIntent) {
      const rest = tokens.slice(1).join(' ').trim();
      setText(rest);
      setActiveIntent(matchedIntent);
      await dispatch({ text: rest, intent: matchedIntent, origin: 'voice' });
      return;
    }
    setText(transcript);
    await dispatch({ text: transcript, origin: 'voice' });
  };

  const placeholder = listening
    ? 'Listening… release to transcribe'
    : transcribing
    ? 'Transcribing…'
    : downloadProgress?.status === 'downloading'
    ? `Loading whisper model ${downloadProgress.progress != null ? `· ${Math.round(downloadProgress.progress)}%` : ''}`
    : activeIntent
    ? activeIntent.placeholder ?? `${activeIntent.label}…`
    : activeSkill
    ? `${activeSkill.name} — add a prompt or press Enter`
    : '/ to pick · ask anything';

  const displayValue = text;

  return (
    <div className="palette palette-body" ref={paletteRef}>
      <div className="palette__inner">
        <span className="palette__prompt" aria-hidden>›</span>
        {activeIntent && (
          <span className="skill-chip skill-chip--intent">
            {activeIntent.label}
            <button
              className="skill-chip__remove"
              onClick={() => setActiveIntent(null)}
              title="Clear intent"
            >
              ×
            </button>
          </span>
        )}
        {activeSkill && (
          <span className="skill-chip">
            {activeSkill.name}
            <button
              className="skill-chip__remove"
              onClick={() => setActiveSkill(null)}
              title="Clear skill"
            >
              ×
            </button>
          </span>
        )}
        <input
          ref={inputRef}
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (pickerOpen && matches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPickerIndex((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPickerIndex((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const pick = matches[pickerIndex];
                if (pick) selectRow(pick);
                return;
              }
            }
            if (e.key === 'Enter') void dispatch();
            if (e.key === 'Escape') {
              if (activeIntent) {
                setActiveIntent(null);
                return;
              }
              if (activeSkill) {
                setActiveSkill(null);
                return;
              }
              window.close();
            }
            if (e.key === 'Backspace' && !text) {
              if (activeIntent) setActiveIntent(null);
              else if (activeSkill) setActiveSkill(null);
            }
          }}
        />
        <button
          className={`mic${listening ? ' listening' : ''}${transcribing ? ' transcribing' : ''}`}
          title={
            transcribing
              ? 'Transcribing…'
              : listening
              ? 'Release to transcribe'
              : 'Hold to dictate'
          }
          onMouseDown={() => void startVoice()}
          onMouseUp={() => void stopVoice()}
          onMouseLeave={() => void stopVoice()}
          disabled={transcribing}
          aria-label="Toggle voice input"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="4" y="2" width="4" height="6" rx="2" stroke="currentColor" />
            <path d="M3 6.5C3 8 4 9 6 9C8 9 9 8 9 6.5" stroke="currentColor" strokeLinecap="round" />
            <line x1="6" y1="9" x2="6" y2="11" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </button>
        <span className="hint">
          {schedulePreview ? (
            <span className="palette__schedule-hint" title="Press Enter to schedule">
              {schedulePreview.mode === 'scheduled' ? '⚡' : '⏰'}{' '}
              {formatScheduleHint(schedulePreview.fireAt)}
            </span>
          ) : (
            '↵ exec'
          )}
        </span>
      </div>
      {downloadProgress?.status === 'downloading' && (
        <div className="palette__progress">
          downloading whisper model
          {downloadProgress.file ? ` · ${downloadProgress.file}` : ''}
          {downloadProgress.progress != null && (
            <span className="palette__progress-bar">
              <span
                className="palette__progress-fill"
                style={{ width: `${Math.round(downloadProgress.progress)}%` }}
              />
            </span>
          )}
        </div>
      )}
      {error && <div className="palette__error">{error}</div>}
      {pickerOpen && matches.length > 0 && (
        <div className="skill-picker">
          {matches.map((row, i) => {
            const isActive = i === pickerIndex;
            const className = `skill-picker__row${
              isActive ? ' skill-picker__row--active' : ''
            }`;
            if (row.kind === 'intent') {
              return (
                <div
                  key={`intent-${row.value.moduleId}-${row.value.id}`}
                  className={className}
                  onMouseEnter={() => setPickerIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectRow(row);
                  }}
                >
                  <div className="skill-picker__name">
                    <span className="skill-picker__kind">module</span>
                    {row.value.prefix} · {row.value.label}
                  </div>
                  {row.value.description && (
                    <div className="skill-picker__desc">{row.value.description}</div>
                  )}
                </div>
              );
            }
            return (
              <div
                key={`skill-${row.value.id}`}
                className={className}
                onMouseEnter={() => setPickerIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectRow(row);
                }}
              >
                <div className="skill-picker__name">
                  <span className="skill-picker__kind">skill</span>
                  {row.value.name}
                </div>
                {row.value.description && (
                  <div className="skill-picker__desc">{row.value.description}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {pickerOpen && matches.length === 0 && (
        <div className="skill-picker">
          <div className="skill-picker__empty">
            No matches. Drop a SKILL.md or write a module.
          </div>
        </div>
      )}
    </div>
  );
}
