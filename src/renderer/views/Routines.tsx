import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import type {
  DashboardConfig,
  DashboardItem,
  RoutineDef,
  SkillSummary,
  TaskSummary,
} from '../../shared/types';
import { MarkdownDoc } from './MarkdownText';
import { TaskAnswerPreview } from './TaskAnswerPreview';
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

/**
 * Rail-then-main layout (same shape as Briefings + Skills): all routines
 * listed on the left grouped by purpose, selected routine renders detail
 * on the right with schedule, action buttons, output link, and an
 * "Add to dashboard" picker for one-click pinning.
 */
export function Routines() {
  const [routines, setRoutines] = useState<RoutineDef[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [draft, setDraft] = useState<DraftRoutine | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  /** Task ids currently in 'running'/'queued' state — used to flash a
   * "running" dot on each affected routine. Maintained by subscribing
   * to onTaskStatus on the live task feed. */
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const refresh = async () => {
      const all = await window.jarvis.listTasks();
      const next = new Set<string>();
      for (const t of all) {
        if (t.status === 'running' || t.status === 'queued') next.add(t.id);
      }
      setRunningTaskIds(next);
    };
    void refresh();
    const off = window.jarvis.onTaskStatus((summary) => {
      setRunningTaskIds((prev) => {
        const isLive =
          summary.status === 'running' || summary.status === 'queued';
        if (isLive && !prev.has(summary.id)) {
          return new Set([...prev, summary.id]);
        }
        if (!isLive && prev.has(summary.id)) {
          const next = new Set(prev);
          next.delete(summary.id);
          return next;
        }
        return prev;
      });
    });
    return off;
  }, []);

  const isRoutineRunning = (r: RoutineDef): boolean => {
    if (!r.recentTaskIds || r.recentTaskIds.length === 0) return false;
    return r.recentTaskIds.some((id) => runningTaskIds.has(id));
  };

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

  // Auto-pick a routine when the list loads if nothing's selected.
  useEffect(() => {
    if (!activeId && routines.length > 0) {
      setActiveId(routines[0]!.id);
    }
    if (activeId && !routines.some((r) => r.id === activeId)) {
      setActiveId(routines[0]?.id ?? null);
    }
  }, [routines, activeId]);

  const skillsById = useMemo(
    () => new Map(skills.map((s) => [s.id, s])),
    [skills],
  );

  const active = useMemo(
    () => routines.find((r) => r.id === activeId) ?? null,
    [routines, activeId],
  );

  const startBlank = () => {
    setError(null);
    setPresetsOpen(false);
    setDraft({ ...EMPTY_DRAFT, skillId: skills[0]?.id ?? '' });
  };

  const startFromPreset = (preset: Preset) => {
    setError(null);
    setPresetsOpen(false);
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
      const saved = await window.jarvis.saveRoutine(draft);
      setActiveId(saved.id);
      setDraft(null);
      setError(null);
      toast({ message: 'Routine saved' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (r: RoutineDef) => {
    if (
      !confirm(
        `Delete routine "${skillsById.get(r.skillId)?.name ?? r.id}"? The skill stays; only the schedule is removed.`,
      )
    )
      return;
    void window.jarvis.deleteRoutine(r.id);
    toast({ kind: 'info', message: 'Routine deleted' });
  };

  const runNow = (r: RoutineDef) => {
    void window.jarvis.runRoutineNow(r.id);
    toast({ message: 'Routine running…' });
  };

  const toggle = async (r: RoutineDef) => {
    try {
      await window.jarvis.saveRoutine({ ...r, enabled: !r.enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleShowInCalendar = async (r: RoutineDef) => {
    try {
      await window.jarvis.saveRoutine({
        ...r,
        showInCalendar: r.showInCalendar === false ? true : false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="briefings">
      <aside className="briefings__rail">
        <h2 className="briefings__rail-head">ROUTINES</h2>
        <p className="briefings__rail-hint">
          Skills on a schedule · cron in local time. Click a routine to
          see details + actions on the right.
        </p>

        <div className="routines__rail-actions">
          <button
            className="briefings__generate"
            onClick={startBlank}
            disabled={skills.length === 0}
          >
            + New routine
          </button>
          <button
            className="routines__preset-toggle"
            onClick={() => setPresetsOpen((v) => !v)}
            disabled={skills.length === 0}
            title="Recommended presets"
          >
            {presetsOpen ? '▾ Presets' : '▸ Presets'}
          </button>
        </div>

        {presetsOpen && (
          <div className="routines__preset-list">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className="routines__preset-row"
                onClick={() => startFromPreset(p)}
              >
                <div className="routines__preset-name">{p.name}</div>
                <div className="routines__preset-desc">{p.description}</div>
                <div className="routines__preset-cron">{humanCron(p.cron)}</div>
              </button>
            ))}
          </div>
        )}

        {skills.length === 0 && (
          <div className="briefings__empty" style={{ marginTop: 12 }}>
            No skills loaded. Drop a SKILL.md in{' '}
            <code>~/.jarvis/skills/</code> first.
          </div>
        )}

        {routines.length === 0 && skills.length > 0 && (
          <div className="briefings__empty" style={{ marginTop: 12 }}>
            No routines yet. Open <strong>Presets</strong> above or click{' '}
            <strong>+ New routine</strong>.
          </div>
        )}

        {groupRoutinesByPurpose(routines).map(({ purpose, label, items }) => (
          <Fragment key={purpose}>
            <div className="routines__rail-section">
              {label} · {items.length}
            </div>
            {items.map((r) => {
              const skill = skillsById.get(r.skillId);
              const isActive = r.id === activeId;
              const running = isRoutineRunning(r);
              return (
                <button
                  key={r.id}
                  className={`briefings__kind${isActive ? ' briefings__kind--active' : ''}${r.enabled ? '' : ' routines__rail-card--off'}${running ? ' routines__rail-card--running' : ''}`}
                  onClick={() => setActiveId(r.id)}
                >
                  <div className="briefings__kind-label">
                    {running ? (
                      <span
                        className="briefings__kind-on-dot briefings__kind-on-dot--running"
                        title="A task spawned by this routine is currently running"
                      />
                    ) : r.enabled ? (
                      <span
                        className="briefings__kind-on-dot"
                        title="Enabled"
                      />
                    ) : null}
                    {skill?.name ?? r.skillId}
                  </div>
                  <div className="briefings__kind-desc">
                    {r.input || <em>no input</em>}
                  </div>
                  <div className="briefings__kind-schedule">
                    {running ? 'running…' : humanCron(r.cron)}
                    {!r.enabled && !running && ' · disabled'}
                  </div>
                </button>
              );
            })}
          </Fragment>
        ))}
      </aside>

      <main className="briefings__main">
        {!active && (
          <div className="briefings__placeholder">
            {routines.length === 0
              ? 'No routines yet. Create one on the left.'
              : 'Pick a routine on the left.'}
          </div>
        )}
        {active && (
          <RoutineDetail
            routine={active}
            skill={skillsById.get(active.skillId)}
            isRunning={isRoutineRunning(active)}
            onEdit={() => edit(active)}
            onRemove={() => remove(active)}
            onRunNow={() => runNow(active)}
            onToggle={() => void toggle(active)}
            onToggleShowInCalendar={() => void toggleShowInCalendar(active)}
          />
        )}
      </main>

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

function RoutineDetail({
  routine,
  skill,
  isRunning,
  onEdit,
  onRemove,
  onRunNow,
  onToggle,
  onToggleShowInCalendar,
}: {
  routine: RoutineDef;
  skill: SkillSummary | undefined;
  isRunning: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onRunNow: () => void;
  onToggle: () => void;
  onToggleShowInCalendar: () => void;
}) {
  const purpose = derivePurpose(routine);
  // Default: visible. Only hidden if explicitly set to false.
  const showInCalendar = routine.showInCalendar !== false;

  return (
    <>
      <header className="briefings__main-head">
        <div>
          <h3 className="briefings__main-title">
            {skill?.name ?? (
              <span style={{ color: 'var(--bad)' }}>
                missing: {routine.skillId}
              </span>
            )}
            {isRunning && (
              <span
                className="routine-detail__running"
                title="A task spawned by this routine is currently running"
              >
                <span className="routine-detail__running-dot" />
                running
              </span>
            )}
          </h3>
          <div className="briefings__main-hint">
            <code>{routine.id}</code>
            {' · skill '}
            <button
              className="briefings__schedule-link"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('jarvis:navigate', {
                    detail: { tab: 'skills', skillId: routine.skillId },
                  }),
                )
              }
            >
              {routine.skillId}
            </button>
          </div>
        </div>
        <label
          className="toggle"
          title={routine.enabled ? 'Disable' : 'Enable'}
        >
          <input
            type="checkbox"
            checked={routine.enabled}
            onChange={onToggle}
          />
          {routine.enabled ? 'on' : 'off'}
        </label>
      </header>

      <div className="briefings__schedule">
        <div className="briefings__schedule-status">
          <span
            className={`briefings__schedule-dot${isRunning ? ' briefings__schedule-dot--running' : routine.enabled ? ' briefings__schedule-dot--on' : ' briefings__schedule-dot--off'}`}
          />
          <span className="briefings__schedule-label">
            {humanCron(routine.cron)}
          </span>
          <code
            className="briefings__schedule-cron"
            title="Raw cron expression"
          >
            {routine.cron}
          </code>
          <span className="briefings__schedule-hint">
            {routine.lastRunAt
              ? `last run ${formatTimestamp(routine.lastRunAt)}`
              : 'never run'}
          </span>
        </div>
        <div className="briefings__schedule-actions">
          <button onClick={onRunNow}>Run now</button>
          <button onClick={onEdit}>Edit</button>
          <AddToDashboardButton routineId={routine.id} />
          <button
            className="briefings__schedule-danger"
            onClick={onRemove}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="routine-detail__meta">
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
        {routine.input && (
          <div className="routine-detail__input">
            <div className="routine-detail__field-label">Input prompt</div>
            <blockquote>{routine.input}</blockquote>
          </div>
        )}
        {routine.condition && (
          <div className="routine-detail__condition">
            <div className="routine-detail__field-label">Watch condition</div>
            <code>{routine.condition}</code>
            <div className="routine-detail__hint">
              Fires only when this shell command exits 0 AND produces non-empty stdout.
            </div>
          </div>
        )}
        {skill && (
          <div className="routine-detail__tools">
            <div className="routine-detail__field-label">Tool access</div>
            <ToolChips skill={skill} />
          </div>
        )}
        <div className="routine-detail__pref">
          <label className="toggle" title="Show upcoming + recent fires of this routine in the Calendar timeline">
            <input
              type="checkbox"
              checked={showInCalendar}
              onChange={onToggleShowInCalendar}
            />
            <span>
              Show in Calendar{' '}
              <span className="routine-detail__hint" style={{ display: 'inline' }}>
                · uncheck for high-frequency routines (every-Nmin pollers)
              </span>
            </span>
          </label>
        </div>
      </div>

      <RoutineOutputPanes routine={routine} purpose={purpose} />
    </>
  );
}

/**
 * Briefings-style three-column block: history list on the left, rendered
 * output on the right. Two shapes:
 *
*   - briefing routines (id prefix briefing-…) — left rail = every file
 *     under ~/.jarvis/briefings/<kindId>/, right = MarkdownDoc render of
 *     the selected file. Routines IS the place to read briefings now;
 *     the standalone Briefings tab was retired.
 *
 *   - everything else — left rail = recentTaskIds the routine has spawned
 *     (newest first, status badge per row), right = the latest assistant
 *     text of the selected task + a link to open the full Observatory
 *     transcript. The view stays useful for freeform routines that don't
 *     produce a structured artefact.
 */
function RoutineOutputPanes({
  routine,
  purpose,
}: {
  routine: RoutineDef;
  purpose: RoutinePurpose | null;
}) {
  const isBriefing = purpose?.kind === 'briefing';
  const briefingKindId = isBriefing
    ? routine.id.slice('briefing-'.length)
    : null;

  if (isBriefing && briefingKindId) {
    return <BriefingHistory kindId={briefingKindId} />;
  }
  return <TaskHistory taskIds={routine.recentTaskIds ?? []} />;
}

function BriefingHistory({ kindId }: { kindId: string }) {
  const [files, setFiles] = useState<
    Array<{ filename: string; mtimeMs: number; title: string }>
  >([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');

  useEffect(() => {
    const refresh = async () => {
      try {
        const list = await window.jarvis.listBriefingFiles(kindId);
        setFiles(list);
        if (list.length > 0 && !list.some((f) => f.filename === activeFile)) {
          setActiveFile(list[0]!.filename);
        }
      } catch {
        setFiles([]);
      }
    };
    void refresh();
    return window.jarvis.onBriefingsChanged(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindId]);

  useEffect(() => {
    if (!activeFile) {
      setContent('');
      return;
    }
    void window.jarvis.readBriefingFile(kindId, activeFile).then(setContent);
  }, [kindId, activeFile]);

  return (
    <div className="briefings__panes routine-detail__panes">
      <aside className="briefings__files">
        {files.length === 0 ? (
          <div className="briefings__empty">
            No briefings yet. Click <strong>Run now</strong> above to
            generate the first one.
          </div>
        ) : (
          files.map((f) => (
            <button
              key={f.filename}
              className={`briefings__file${f.filename === activeFile ? ' briefings__file--active' : ''}`}
              onClick={() => setActiveFile(f.filename)}
            >
              <div className="briefings__file-title">{f.title}</div>
              <div className="briefings__file-meta">
                {new Date(f.mtimeMs).toLocaleString()}
              </div>
            </button>
          ))
        )}
      </aside>
      <article className="briefings__content">
        {!activeFile ? (
          <div className="briefings__empty">Pick a run on the left.</div>
        ) : content ? (
          <MarkdownDoc>{content}</MarkdownDoc>
        ) : (
          <div className="briefings__empty">Loading…</div>
        )}
      </article>
    </div>
  );
}

function TaskHistory({ taskIds }: { taskIds: string[] }) {
  const [summaries, setSummaries] = useState<Map<string, TaskSummary>>(
    () => new Map(),
  );
  const [activeId, setActiveId] = useState<string | null>(taskIds[0] ?? null);

  // Fetch summaries for every known task id; refresh whenever any status
  // changes (covers in-flight runs streaming to completion).
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (taskIds.length === 0) {
        if (!cancelled) setSummaries(new Map());
        return;
      }
      const all = await window.jarvis.listTasks();
      if (cancelled) return;
      const next = new Map<string, TaskSummary>();
      for (const id of taskIds) {
        const t = all.find((x) => x.id === id);
        if (t) next.set(id, t);
      }
      setSummaries(next);
    };
    void refresh();
    const off = window.jarvis.onTaskStatus(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, [taskIds]);

  // Keep activeId synced with the list — pick newest available if the
  // selected one fell out (e.g. on first mount with stale state).
  useEffect(() => {
    if (taskIds.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !taskIds.includes(activeId)) {
      setActiveId(taskIds[0]!);
    }
  }, [taskIds, activeId]);

  if (taskIds.length === 0) {
    return (
      <div className="briefings__panes routine-detail__panes">
        <aside className="briefings__files">
          <div className="briefings__empty">
            No runs yet. Click <strong>Run now</strong> to generate one.
          </div>
        </aside>
        <article className="briefings__content">
          <div className="briefings__empty">No history.</div>
        </article>
      </div>
    );
  }

  return (
    <div className="briefings__panes routine-detail__panes">
      <aside className="briefings__files">
        {taskIds.map((id) => {
          const s = summaries.get(id);
          const isActive = id === activeId;
          const statusLabel = !s
            ? 'loading'
            : s.status === 'running'
              ? 'running'
              : s.awaitingInput
                ? 'awaiting'
                : s.status;
          return (
            <button
              key={id}
              className={`briefings__file${isActive ? ' briefings__file--active' : ''}`}
              onClick={() => setActiveId(id)}
            >
              <div className="briefings__file-title">
                {s ? new Date(s.startedAt).toLocaleString() : id}
              </div>
              <div className="briefings__file-meta routine-history__meta">
                <span
                  className={`routine-history__status routine-history__status--${s?.status ?? 'unknown'}${s?.awaitingInput ? ' routine-history__status--awaiting' : ''}`}
                >
                  ● {statusLabel}
                </span>
                {s?.costUsd != null && s.costUsd > 0 && (
                  <span> · ${s.costUsd.toFixed(4)}</span>
                )}
              </div>
            </button>
          );
        })}
      </aside>
      <article className="briefings__content">
        {activeId ? (
          <TaskAnswerPreview
            taskId={activeId}
            openLabel="open full transcript in Observatory →"
          />
        ) : (
          <div className="briefings__empty">Pick a run on the left.</div>
        )}
      </article>
    </div>
  );
}


/**
 * "Add to dashboard" affordance — opens a small popover listing the
 * user's dashboard sections. Disables sections this routine is already
 * in; lets the user create a brand-new section with this routine
 * pre-pinned for one-click setup.
 */
function AddToDashboardButton({ routineId }: { routineId: string }) {
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.jarvis.readDashboard().then(setConfig);
    return window.jarvis.onDashboardChanged(setConfig);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!config) return null;

  const isPinnedIn = (sectionId: string) =>
    config.sections
      .find((s) => s.id === sectionId)
      ?.items.some(
        (it) => it.kind === 'routine' && it.routineId === routineId,
      ) ?? false;

  const addToExisting = async (sectionId: string) => {
    if (isPinnedIn(sectionId)) return;
    const item: DashboardItem = { kind: 'routine', routineId };
    const next: DashboardConfig = {
      sections: config.sections.map((s) =>
        s.id === sectionId ? { ...s, items: [...s.items, item] } : s,
      ),
    };
    await window.jarvis.writeDashboard(next);
    toast({
      message: `Pinned to "${config.sections.find((s) => s.id === sectionId)!.title}"`,
    });
    setOpen(false);
  };

  const createSectionWith = async () => {
    const title = newName.trim() || 'Untitled';
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    const next: DashboardConfig = {
      sections: [
        ...config.sections,
        {
          id,
          title,
          items: [{ kind: 'routine', routineId }],
        },
      ],
    };
    await window.jarvis.writeDashboard(next);
    toast({ message: `Created "${title}" with this routine` });
    setOpen(false);
    setCreating(false);
    setNewName('');
  };

  return (
    <div className="add-to-dash" ref={wrapperRef}>
      <button
        className="briefings__schedule-link"
        onClick={() => setOpen((v) => !v)}
        title="Pin this routine to a Dashboard section"
      >
        + Add to dashboard
      </button>
      {open && (
        <div className="add-to-dash__menu">
          {config.sections.length === 0 && !creating && (
            <div className="add-to-dash__empty">
              No sections yet. Create the first one below.
            </div>
          )}
          {config.sections.map((s) => {
            const already = isPinnedIn(s.id);
            return (
              <button
                key={s.id}
                className={`add-to-dash__row${already ? ' add-to-dash__row--done' : ''}`}
                onClick={() => void addToExisting(s.id)}
                disabled={already}
                title={already ? 'Already pinned here' : 'Add to this section'}
              >
                <span>{s.title}</span>
                {already && <span className="add-to-dash__done">✓ pinned</span>}
              </button>
            );
          })}
          {!creating && (
            <button
              className="add-to-dash__row add-to-dash__row--new"
              onClick={() => setCreating(true)}
            >
              + New section…
            </button>
          )}
          {creating && (
            <div className="add-to-dash__new">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Section title"
                spellCheck={false}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createSectionWith();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
              />
              <button onClick={() => void createSectionWith()}>Create</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RoutinePurpose {
  kind: 'briefing' | 'inbox' | 'freeform';
  label: string;
  tab?: 'inbox';
}

function derivePurpose(r: RoutineDef): RoutinePurpose | null {
  if (r.id.startsWith('briefing-')) {
    const kindId = r.id.slice('briefing-'.length);
    // No cross-link tab — the briefing's rendered output lives directly
    // below this chip in the routine detail panes.
    return {
      kind: 'briefing',
      label: `Briefing · ${kindId}`,
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

function groupRoutinesByPurpose(
  routines: RoutineDef[],
): { purpose: 'briefing' | 'inbox' | 'freeform'; label: string; items: RoutineDef[] }[] {
  const briefings: RoutineDef[] = [];
  const inbox: RoutineDef[] = [];
  const freeform: RoutineDef[] = [];
  for (const r of routines) {
    const p = derivePurpose(r)?.kind ?? 'freeform';
    if (p === 'briefing') briefings.push(r);
    else if (p === 'inbox') inbox.push(r);
    else freeform.push(r);
  }
  return [
    { purpose: 'briefing' as const, label: 'Briefings', items: briefings },
    { purpose: 'inbox' as const, label: 'Inbox sources', items: inbox },
    { purpose: 'freeform' as const, label: 'Freeform', items: freeform },
  ].filter((g) => g.items.length > 0);
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
