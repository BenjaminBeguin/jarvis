import { useEffect, useMemo, useState } from 'react';

import type { RoutineDef, SkillSummary } from '../../shared/types';

interface DraftRoutine {
  id?: string;
  skillId: string;
  cron: string;
  input: string;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftRoutine = {
  skillId: '',
  cron: '0 9 * * 1-5',
  input: '',
  enabled: true,
};

function formatTimestamp(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function Routines() {
  const [routines, setRoutines] = useState<RoutineDef[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [draft, setDraft] = useState<DraftRoutine | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.jarvis.listRoutines().then(setRoutines);
    void window.jarvis.listSkills().then(setSkills);
    const offR = window.jarvis.onRoutinesChanged(setRoutines);
    const offS = window.jarvis.onSkillsChanged(setSkills);
    return () => {
      offR();
      offS();
    };
  }, []);

  const skillsById = useMemo(
    () => new Map(skills.map((s) => [s.id, s])),
    [skills],
  );

  const startNew = () => {
    setError(null);
    setDraft({
      ...EMPTY_DRAFT,
      skillId: skills[0]?.id ?? '',
    });
  };

  const edit = (r: RoutineDef) => {
    setError(null);
    setDraft({
      id: r.id,
      skillId: r.skillId,
      cron: r.cron,
      input: r.input,
      enabled: r.enabled,
    });
  };

  const submit = async () => {
    if (!draft) return;
    if (!draft.skillId) {
      setError('Pick a skill first.');
      return;
    }
    try {
      await window.jarvis.saveRoutine(draft);
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    await window.jarvis.deleteRoutine(id);
  };

  const runNow = async (id: string) => {
    await window.jarvis.runRoutineNow(id);
  };

  const toggle = async (r: RoutineDef) => {
    try {
      await window.jarvis.saveRoutine({ ...r, enabled: !r.enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="routines">
      <header className="routines__header">
        <div>
          <h2>Routines</h2>
          <p>Skills on a schedule. Cron in the local timezone.</p>
        </div>
        <button onClick={startNew} disabled={skills.length === 0}>
          + New routine
        </button>
      </header>

      {skills.length === 0 && (
        <div className="empty">
          No skills loaded. Drop a SKILL.md in ~/.jarvis/skills/ first.
        </div>
      )}

      {routines.length === 0 && skills.length > 0 && !draft && (
        <div className="empty">No routines yet. Click + to add one.</div>
      )}

      <div className="routines__list">
        {routines.map((r) => {
          const skill = skillsById.get(r.skillId);
          return (
            <div key={r.id} className="routine">
              <div className="routine__main">
                <div className="routine__title">
                  {skill?.name ?? (
                    <span style={{ color: 'var(--bad)' }}>
                      Missing skill: {r.skillId}
                    </span>
                  )}
                </div>
                <div className="routine__meta">
                  <span className="routine__cron">{r.cron}</span>
                  {r.input && (
                    <span title={r.input} className="routine__input-preview">
                      “{r.input.slice(0, 80)}{r.input.length > 80 ? '…' : ''}”
                    </span>
                  )}
                </div>
                <div className="routine__history">
                  last run: {formatTimestamp(r.lastRunAt)}
                </div>
              </div>
              <div className="routine__actions">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={() => void toggle(r)}
                  />
                  {r.enabled ? 'on' : 'off'}
                </label>
                <button onClick={() => void runNow(r.id)}>Run now</button>
                <button onClick={() => edit(r)}>Edit</button>
                <button
                  onClick={() => void remove(r.id)}
                  style={{ borderColor: 'rgba(255,122,122,0.35)' }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {draft && (
        <div className="routine-editor">
          <h3>{draft.id ? 'Edit routine' : 'New routine'}</h3>
          <label>
            <span>Skill</span>
            <select
              value={draft.skillId}
              onChange={(e) =>
                setDraft({ ...draft, skillId: e.target.value })
              }
            >
              <option value="">Pick a skill…</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Cron (5 fields: m h dom mon dow)</span>
            <input
              value={draft.cron}
              onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
              placeholder="0 9 * * 1-5"
            />
          </label>
          <label>
            <span>Input (sent as the user prompt)</span>
            <textarea
              value={draft.input}
              rows={3}
              onChange={(e) =>
                setDraft({ ...draft, input: e.target.value })
              }
              placeholder="Optional. Defaults to 'Run.'"
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            <span>Enabled</span>
          </label>
          {error && <div className="routine-editor__error">{error}</div>}
          <div className="routine-editor__actions">
            <button onClick={() => setDraft(null)}>Cancel</button>
            <button onClick={() => void submit()}>Save</button>
          </div>
        </div>
      )}
    </section>
  );
}
