import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ModuleSummary,
  PaletteIntentSummary,
  SkillSummary,
  TranscribeProgress,
} from '../../shared/types';
import { AudioCapture } from '../voice/AudioCapture';

interface PendingIntent extends PaletteIntentSummary {}

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
  const captureRef = useRef<AudioCapture | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const intents = useMemo<PaletteIntentSummary[]>(
    () => modules.flatMap((m) => m.intents),
    [modules],
  );

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

  const dispatch = async () => {
    setError(null);
    const prompt = text.trim();
    if (activeIntent) {
      try {
        const result = await window.jarvis.dispatchIntent(
          activeIntent.moduleId,
          activeIntent.id,
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
    if (!prompt && !activeSkill) return;
    try {
      await window.jarvis.launchTask({
        prompt: prompt || (activeSkill ? 'Begin.' : ''),
        skillId: activeSkill?.id ?? null,
        origin: 'palette',
      });
      setText('');
      setActiveSkill(null);
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
      // ArrayBuffer transfers across IPC efficiently; new Float32Array views
      // it directly in the main process without a copy.
      const text = await window.jarvis.transcribe(result.pcm.buffer as ArrayBuffer);
      if (!text) {
        setError("Couldn't make out the audio. Try again with less background noise.");
        return;
      }
      setText((prev) => (prev ? `${prev} ${text}` : text));
    } catch (e) {
      setError(`Transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTranscribing(false);
    }
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
    <div className="palette palette-body">
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
        <span className="hint">↵ exec</span>
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
