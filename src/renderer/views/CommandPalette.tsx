import { useEffect, useMemo, useRef, useState } from 'react';

import type { SkillSummary } from '../../shared/types';
import {
  createTranscriber,
  isVoiceSupported,
  type VoiceTranscriber,
} from '../voice/WebSpeechTranscriber';

export function CommandPalette() {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [activeSkill, setActiveSkill] = useState<SkillSummary | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const transcriberRef = useRef<VoiceTranscriber | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void window.jarvis.listSkills().then(setSkills);
    const off = window.jarvis.onSkillsChanged(setSkills);
    return off;
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pickerOpen = text.startsWith('/');
  const filter = pickerOpen ? text.slice(1).toLowerCase().trim() : '';

  const matches = useMemo(() => {
    if (!pickerOpen) return [] as SkillSummary[];
    const tokens = filter.split(/\s+/).filter(Boolean);
    return skills.filter((s) => {
      if (tokens.length === 0) return true;
      const haystack = `${s.name} ${s.description}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [skills, filter, pickerOpen]);

  useEffect(() => {
    if (pickerIndex >= matches.length) setPickerIndex(0);
  }, [matches.length, pickerIndex]);

  const launch = async (value: string) => {
    const prompt = value.trim();
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
      console.error('launch failed', e);
    }
  };

  const selectSkill = (skill: SkillSummary) => {
    setActiveSkill(skill);
    setText('');
    setPickerIndex(0);
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
    : activeSkill
    ? `${activeSkill.name} — add a prompt or press Enter`
    : '/ to pick a skill · ask anything';

  const displayValue = listening && partial ? partial : text;

  return (
    <div className="palette palette-body">
      <div className="palette__inner">
        <span className="palette__prompt" aria-hidden>›</span>
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
                if (pick) selectSkill(pick);
                return;
              }
            }
            if (e.key === 'Enter') void launch(text);
            if (e.key === 'Escape') {
              if (activeSkill) {
                setActiveSkill(null);
                return;
              }
              window.close();
            }
            if (e.key === 'Backspace' && !text && activeSkill) {
              setActiveSkill(null);
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
      {pickerOpen && matches.length > 0 && (
        <div className="skill-picker">
          {matches.map((s, i) => (
            <div
              key={s.id}
              className={`skill-picker__row${
                i === pickerIndex ? ' skill-picker__row--active' : ''
              }`}
              onMouseEnter={() => setPickerIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSkill(s);
              }}
            >
              <div className="skill-picker__name">{s.name}</div>
              {s.description && (
                <div className="skill-picker__desc">{s.description}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {pickerOpen && matches.length === 0 && (
        <div className="skill-picker">
          <div className="skill-picker__empty">
            No skills match. Drop a SKILL.md in ~/.jarvis/skills/.
          </div>
        </div>
      )}
    </div>
  );
}
