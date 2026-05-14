import { useEffect, useMemo, useState } from 'react';

import type { RoutineDef, SkillSummary } from '../../shared/types';
import { toast } from './Toaster';

interface DraftRoutine {
  id?: string;
  skillId: string;
  cron: string;
  input: string;
  enabled: boolean;
}

interface Preset {
  id: string;
  name: string;
  description: string;
  cron: string;
  input: string;
}

const PRESETS: Preset[] = [
  {
    id: 'morning-brief',
    name: 'Morning brief',
    description: 'Overnight digest at 9 AM weekdays.',
    cron: '0 9 * * 1-5',
    input: 'Brief me on overnight activity. Lead with action items.',
  },
  {
    id: 'end-of-day',
    name: 'End-of-day recap',
    description: 'What happened today, ready at 6 PM.',
    cron: '0 18 * * 1-5',
    input: 'Recap what happened in my tools today and what needs follow-up.',
  },
  {
    id: 'hourly-pulse',
    name: 'Hourly pulse',
    description: 'Quick check every hour during the workday.',
    cron: '0 9-17 * * 1-5',
    input: 'Any urgent items in the last hour I should jump on?',
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    description: 'Friday 4 PM — wins and follow-ups for next week.',
    cron: '0 16 * * 5',
    input: 'What went well this week? What should I follow up on next week?',
  },
];

const EMPTY_DRAFT: DraftRoutine = {
  skillId: '',
  cron: '0 9 * * 1-5',
  input: '',
  enabled: true,
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Best-effort English rendering for common cron shapes. Falls back to the raw
 * expression when the pattern isn't one we explicitly recognize — better to
 * be honest than to invent a wrong description.
 */
function humanCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];

  if (m.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `every ${m.slice(2)} min`;
  }
  if (m === '0' && h.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    return `every ${h.slice(2)}h on the hour`;
  }

  // Comma-separated hours like "9-17" or "9,12,17"
  const hourRangeOnHour =
    m === '0' &&
    /^[\d,-]+$/.test(h) &&
    dom === '*' &&
    mon === '*';
  if (hourRangeOnHour && dow === '*') return `every hour from ${h}`;
  if (hourRangeOnHour && dow === '1-5') return `every hour ${h} on weekdays`;

  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*') {
    const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    if (dow === '*') return `${time} daily`;
    if (dow === '1-5') return `${time} weekdays`;
    if (dow === '0,6' || dow === '6,0' || dow === '6-0') return `${time} weekends`;
    if (/^\d+$/.test(dow)) {
      const d = parseInt(dow, 10);
      if (d >= 0 && d <= 6) return `${time} on ${DAY_NAMES[d]}`;
    }
  }

  return expr;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

interface Props {
  // Allows the parent shell to pass status if we ever need it.
}

export function Routines(_: Props = {}) {
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

  const startBlank = () => {
    setError(null);
    setDraft({ ...EMPTY_DRAFT, skillId: skills[0]?.id ?? '' });
  };

  const startFromPreset = (preset: Preset) => {
    setError(null);
    setDraft({
      ...EMPTY_DRAFT,
      skillId: skills[0]?.id ?? '',
      cron: preset.cron,
      input: preset.input,
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
      toast({ message: 'Routine saved' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (id: string) => {
    void window.jarvis.deleteRoutine(id);
    toast({ kind: 'info', message: 'Routine deleted' });
  };
  const runNow = (id: string) => {
    void window.jarvis.runRoutineNow(id);
    toast({ message: 'Routine running…' });
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
          <h2>ROUTINES</h2>
          <p>Skills on a schedule · cron in local time</p>
        </div>
        <button onClick={startBlank} disabled={skills.length === 0}>
          + NEW ROUTINE
        </button>
      </header>

      {skills.length === 0 && (
        <div className="routines__notice">
          No skills loaded. Drop a SKILL.md in <code>~/.jarvis/skills/</code> first.
        </div>
      )}

      {skills.length > 0 && (
        <>
          <SectionLabel>Recommended</SectionLabel>
          <div className="routines__preset-row">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className="bracketed routines__preset"
                onClick={() => startFromPreset(p)}
              >
                <div className="routines__preset-name">{p.name}</div>
                <div className="routines__preset-desc">{p.description}</div>
                <div className="routines__preset-cron">{humanCron(p.cron)}</div>
              </button>
            ))}
          </div>
        </>
      )}

      <SectionLabel>
        Active{routines.length > 0 ? ` · ${routines.length}` : ''}
      </SectionLabel>
      {routines.length === 0 && skills.length > 0 && !draft && (
        <div className="routines__notice">
          No routines yet. Pick a recommended preset above, or hit + New.
        </div>
      )}
      <div className="routines__grid">
        {routines.map((r) => {
          const skill = skillsById.get(r.skillId);
          return (
            <RoutineCard
              key={r.id}
              routine={r}
              skill={skill}
              onEdit={() => edit(r)}
              onRemove={() => remove(r.id)}
              onRunNow={() => runNow(r.id)}
              onToggle={() => void toggle(r)}
            />
          );
        })}
      </div>

      {draft && (
        <RoutineEditor
          draft={draft}
          skills={skills}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
          error={error}
        />
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="routines__section-label">{children}</div>;
}

interface CardProps {
  routine: RoutineDef;
  skill: SkillSummary | undefined;
  onEdit: () => void;
  onRemove: () => void;
  onRunNow: () => void;
  onToggle: () => void;
}

function RoutineCard({ routine, skill, onEdit, onRemove, onRunNow, onToggle }: CardProps) {
  const purpose = derivePurpose(routine);
  return (
    <article className={`bracketed routine-card${routine.enabled ? '' : ' routine-card--off'}`}>
      <div className="routine-card__head">
        <div className="routine-card__name">
          {skill?.name ?? <span style={{ color: 'var(--bad)' }}>missing: {routine.skillId}</span>}
        </div>
        <label className="toggle" title={routine.enabled ? 'Disable' : 'Enable'}>
          <input type="checkbox" checked={routine.enabled} onChange={onToggle} />
          {routine.enabled ? 'on' : 'off'}
        </label>
      </div>

      {purpose && (
        <button
          className={`routine-card__purpose routine-card__purpose--${purpose.kind}`}
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent('jarvis:navigate', {
                detail: purpose.tab ? { tab: purpose.tab } : null,
              }),
            );
          }}
          title={`Jump to ${purpose.label} in the ${purpose.tab ?? 'app'} tab`}
        >
          <span className="routine-card__purpose-dot" />
          {purpose.label}
        </button>
      )}

      <div className="routine-card__cron">{humanCron(routine.cron)}</div>
      <div className="routine-card__cron-raw">{routine.cron}</div>

      {routine.condition && (
        <div className="routine-card__condition" title="Watch condition — fires only when this shell command produces non-empty stdout">
          watch · <code>{routine.condition}</code>
        </div>
      )}

      {routine.input && (
        <div className="routine-card__input">“{routine.input}”</div>
      )}

      <ToolChips skill={skill} />

      <div className="routine-card__last">last run · {formatTimestamp(routine.lastRunAt)}</div>

      <div className="routine-card__actions">
        <button onClick={onRunNow}>Run now</button>
        <button onClick={onEdit}>Edit</button>
        <button
          onClick={onRemove}
          style={{ borderColor: 'rgba(255,85,119,0.35)', color: 'var(--bad)' }}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

/**
 * Tag a routine with what it actually drives, so the user understands
 * the wiring at a glance. Matches by id prefix / skillId pattern —
 * stable across renames because the matching keys are stable.
 */
interface RoutinePurpose {
  kind: 'briefing' | 'inbox' | 'freeform';
  label: string;
  tab?: 'briefings' | 'inbox';
}

function derivePurpose(r: RoutineDef): RoutinePurpose | null {
  if (r.id.startsWith('briefing-')) {
    const kindId = r.id.slice('briefing-'.length);
    return {
      kind: 'briefing',
      label: `Briefing · ${kindId}`,
      tab: 'briefings',
    };
  }
  if (r.skillId.endsWith('-inbox') || r.skillId === 'calendar-today') {
    return {
      kind: 'inbox',
      label: `Inbox source · ${r.skillId}`,
      tab: 'inbox',
    };
  }
  return { kind: 'freeform', label: 'Freeform' };
}

function ToolChips({ skill }: { skill: SkillSummary | undefined }) {
  if (!skill) return null;
  const tools = skill.allowedTools;
  const servers = skill.mcpServers;
  if (tools.length === 0 && servers.length === 0) {
    return <div className="routine-card__tools routine-card__tools--empty">No tool access</div>;
  }
  return (
    <div className="routine-card__tools">
      {tools.map((t) => (
        <span key={`tool-${t}`} className="tool-chip">{t}</span>
      ))}
      {servers.map((s) => (
        <span key={`mcp-${s}`} className="tool-chip tool-chip--mcp" title="MCP server">
          mcp · {s}
        </span>
      ))}
    </div>
  );
}

interface EditorProps {
  draft: DraftRoutine;
  skills: SkillSummary[];
  onChange: (next: DraftRoutine) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error: string | null;
}

function RoutineEditor({ draft, skills, onChange, onSubmit, onCancel, error }: EditorProps) {
  const selectedSkill = skills.find((s) => s.id === draft.skillId);

  return (
    <div className="routine-editor-backdrop" onClick={onCancel}>
      <div
        className="bracketed routine-editor"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="routine-editor__head">
          <h3>{draft.id ? 'Edit routine' : 'New routine'}</h3>
          <button onClick={onCancel} className="routine-editor__close" title="Close">×</button>
        </header>

        <label>
          <span>Skill</span>
          <select
            value={draft.skillId}
            onChange={(e) => onChange({ ...draft, skillId: e.target.value })}
          >
            <option value="">Pick a skill…</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {selectedSkill && (
            <div className="routine-editor__skill-tools">
              <ToolChips skill={selectedSkill} />
            </div>
          )}
        </label>

        <label>
          <span>Schedule (cron · 5 fields: m h dom mon dow)</span>
          <input
            value={draft.cron}
            onChange={(e) => onChange({ ...draft, cron: e.target.value })}
            placeholder="0 9 * * 1-5"
          />
          <div className="routine-editor__cron-human">
            → {humanCron(draft.cron)}
          </div>
        </label>

        <label>
          <span>Input (sent as the user prompt)</span>
          <textarea
            value={draft.input}
            rows={3}
            onChange={(e) => onChange({ ...draft, input: e.target.value })}
            placeholder="Optional. Defaults to 'Run.'"
          />
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>

        {error && <div className="routine-editor__error">{error}</div>}

        <div className="routine-editor__actions">
          <button onClick={onCancel}>Cancel</button>
          <button onClick={onSubmit}>Save</button>
        </div>
      </div>
    </div>
  );
}
