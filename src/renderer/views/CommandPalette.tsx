import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ModuleSummary,
  PaletteIntentSummary,
  SkillSummary,
} from '../../shared/types';
import {
  createTranscriber,
  isVoiceSupported,
  type VoiceTranscriber,
} from '../voice/WebSpeechTranscriber';

interface PendingIntent extends PaletteIntentSummary {}

export function CommandPalette() {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [activeSkill, setActiveSkill] = useState<SkillSummary | null>(null);
  const [activeIntent, setActiveIntent] = useState<PendingIntent | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const transcriberRef = useRef<VoiceTranscriber | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void window.jarvis.listSkills().then(setSkills);
    void window.jarvis.listModules().then(setModules);
    const offS = window.jarvis.onSkillsChanged(setSkills);
    const offM = window.jarvis.onModulesChanged(setModules);
    return () => {
      offS();
      offM();
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
        setPartial('');
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
      setPartial('');
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

  const startVoice = () => {
    if (transcriberRef.current) return;
    const t = createTranscriber({
      onPartial: (txt) => setPartial(txt),
      onFinal: (txt) => {
        setText((prev) => (prev ? `${prev} ${txt}` : txt));
        setPartial('');
      },
      onError: (msg) => {
        console.warn('voice error', msg);
        setListening(false);
      },
      onEnd: () => {
        setListening(false);
        transcriberRef.current = null;
      },
    });
    if (!t) return;
    transcriberRef.current = t;
    t.start();
    setListening(true);
  };

  const stopVoice = () => {
    transcriberRef.current?.stop();
  };

  const placeholder = listening
    ? partial || 'Listening…'
    : activeIntent
    ? activeIntent.placeholder ?? `${activeIntent.label}…`
    : activeSkill
    ? `${activeSkill.name} — add a prompt or press Enter`
    : '/ to pick · ask anything';

  const displayValue = listening && partial ? partial : text;

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
        {isVoiceSupported() && (
          <button
            className={`mic${listening ? ' listening' : ''}`}
            title={listening ? 'Stop listening' : 'Hold to dictate'}
            onMouseDown={startVoice}
            onMouseUp={stopVoice}
            onMouseLeave={stopVoice}
            aria-label="Toggle voice input"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="4" y="2" width="4" height="6" rx="2" stroke="currentColor" />
              <path d="M3 6.5C3 8 4 9 6 9C8 9 9 8 9 6.5" stroke="currentColor" strokeLinecap="round" />
              <line x1="6" y1="9" x2="6" y2="11" stroke="currentColor" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <span className="hint">↵ exec</span>
      </div>
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
