import { Fragment } from 'react';

import type {
  RoutineDef,
  SkillSummary,
  TaskSummary,
} from '../../../shared/types';

/**
 * Index page — every routine as a row. Click a row to open its
 * detail page (schedule + actions + history); click the inline
 * toggle to enable / disable without leaving the list.
 *
 * Visually matches WorkflowsList — same `.wf-list*` classes — so
 * the two index pages read as a pair.
 *
 * Rows are grouped by purpose (Briefings · Inbox sources · Freeform)
 * preserving the previous rail mental model; the user can also
 * filter via the search input above the body.
 */

export interface RoutinesListProps {
  routines: RoutineDef[];
  skillsById: Map<string, SkillSummary>;
  /** Live task ids in 'running'/'queued' status; used to paint
   *  the row dot in accent + pulse. */
  runningTaskIds: Set<string>;
  /** 30-day rolled-up cost per routine. Shown inline in meta when
   *  > 0 — gives the user a quick "which is expensive" scan. */
  routineCost: Map<string, { totalUsd: number; taskCount: number }>;
  /** Recent task summaries per routine id, newest-first. Drives
   *  the per-row health sparkline. */
  recentByRoutine: Map<string, TaskSummary[]>;
  /** Free-text filter on skill name / id / cron / input. */
  search: string;
  onSelect: (id: string) => void;
  onToggle: (routine: RoutineDef, next: boolean) => void;
  /** Fire the routine immediately. Surfaced as a ▶ button on each
   *  row so the user doesn't have to drill in just to dispatch. */
  onRunNow?: (routine: RoutineDef) => void;
  /** Whether any skills are loaded. We block the empty-state hint
   *  "create your first routine" when there are no skills yet
   *  because the editor can't open. */
  hasSkills: boolean;
  /** Greyed out + tooltipped when true. AI-firing actions (run-now)
   *  silent-skip in pause mode anyway; this just makes that
   *  visible. */
  paused?: boolean;
}

export function RoutinesList({
  routines,
  skillsById,
  runningTaskIds,
  routineCost,
  recentByRoutine,
  search,
  onSelect,
  onToggle,
  onRunNow,
  hasSkills,
  paused = false,
}: RoutinesListProps) {
  if (!hasSkills) {
    return (
      <div className="wf-list wf-list--empty">
        No skills loaded. Drop a SKILL.md in{' '}
        <code>~/.jarvis/skills/</code> first, then come back here to
        schedule it.
      </div>
    );
  }

  if (routines.length === 0) {
    return (
      <div className="wf-list wf-list--empty">
        No routines yet. Pick a preset above or click{' '}
        <strong>+ New routine</strong> to schedule a skill.
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? routines.filter((r) => {
        const skill = skillsById.get(r.skillId);
        const haystack = [
          skill?.name,
          r.skillId,
          r.id,
          r.input,
          r.cron,
          derivePurpose(r).label,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      })
    : routines;

  if (filtered.length === 0) {
    return (
      <div className="wf-list wf-list--empty">
        No routines match "{search}".
      </div>
    );
  }

  const groups = groupByPurpose(filtered);

  return (
    <div className="wf-list">
      {groups.map((g, idx) => (
        <Fragment key={g.purpose}>
          {idx > 0 && (
            <h3 className="wf-list__subheader">
              {g.icon} {g.label}
            </h3>
          )}
          {idx === 0 && groups.length > 1 && (
            <h3
              className="wf-list__subheader"
              style={{ borderTop: 'none', paddingTop: 0 }}
            >
              {g.icon} {g.label}
            </h3>
          )}
          <div className="wf-list__group">
            {g.items.map((r) => (
              <RoutineRow
                key={r.id}
                routine={r}
                skill={skillsById.get(r.skillId)}
                running={isRunning(r, runningTaskIds)}
                cost={routineCost.get(r.id)}
                recent={recentByRoutine.get(r.id) ?? []}
                onSelect={() => onSelect(r.id)}
                onToggle={(next) => onToggle(r, next)}
                onRunNow={onRunNow ? () => onRunNow(r) : undefined}
                paused={paused}
              />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function RoutineRow({
  routine: r,
  skill,
  running,
  cost,
  recent,
  onSelect,
  onToggle,
  onRunNow,
  paused,
}: {
  routine: RoutineDef;
  skill: SkillSummary | undefined;
  running: boolean;
  cost: { totalUsd: number; taskCount: number } | undefined;
  recent: TaskSummary[];
  onSelect: () => void;
  onToggle: (next: boolean) => void;
  onRunNow?: () => void;
  paused: boolean;
}) {
  const purpose = derivePurpose(r);
  const ok = recent.filter((t) => t.status === 'completed').length;
  return (
    <article
      className={`wf-list__row${r.enabled ? '' : ' wf-list__row--off'}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        className={`wf-list__dot${running ? ' wf-list__dot--running' : r.enabled ? ' wf-list__dot--on' : ''}`}
        aria-hidden
      />
      <div className="wf-list__main">
        <div className="wf-list__head">
          <span className="wf-list__name">
            {skill?.name ?? (
              <span style={{ color: 'var(--bad)' }}>
                missing: {r.skillId}
              </span>
            )}
          </span>
          <span className="wf-list__meta">
            cron · {humanCron(r.cron)}
            {!r.enabled && !running && ' · disabled'}
            {running && ' · running…'}
            {cost && cost.totalUsd > 0 && (
              <>
                {' · $'}
                {cost.totalUsd >= 0.01
                  ? cost.totalUsd.toFixed(2)
                  : cost.totalUsd.toFixed(4)}
                /30d
              </>
            )}
            {purpose.kind !== 'freeform' && ` · ${purpose.kind}`}
          </span>
        </div>
        {r.input && <div className="wf-list__desc">{r.input}</div>}
        {recent.length > 0 && (
          <div
            className="wf-list__health"
            title={`${ok}/${recent.length} successful · last ${recent.length} run${recent.length === 1 ? '' : 's'}`}
          >
            {[...recent].reverse().map((t) => (
              <span
                key={t.id}
                className={`wf-list__health-cell wf-list__health-cell--${t.status}`}
              />
            ))}
          </div>
        )}
      </div>
      <div
        className="wf-list__actions"
        onClick={(e) => e.stopPropagation()}
      >
        {onRunNow && (
          <button
            type="button"
            className="wf-list__run"
            onClick={(e) => {
              e.stopPropagation();
              if (!paused) onRunNow();
            }}
            disabled={paused}
            title={
              paused
                ? 'Paused — flip the mode to Running to fire this routine'
                : 'Run this routine now'
            }
            aria-label="Run now"
          >
            ▶
          </button>
        )}
        <label
          className="toggle"
          title={r.enabled ? 'Disable schedule' : 'Enable schedule'}
        >
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          {r.enabled ? 'on' : 'off'}
        </label>
        <span className="wf-list__chev" aria-hidden>
          →
        </span>
      </div>
    </article>
  );
}

interface Purpose {
  kind: 'briefing' | 'inbox' | 'freeform';
  label: string;
  icon: string;
}

function derivePurpose(r: RoutineDef): Purpose {
  if (r.id.startsWith('briefing-')) {
    return { kind: 'briefing', label: 'Briefings', icon: '📰' };
  }
  if (r.skillId.endsWith('-inbox') || r.skillId === 'calendar-today') {
    return { kind: 'inbox', label: 'Inbox sources', icon: '📥' };
  }
  return { kind: 'freeform', label: 'Freeform', icon: '◇' };
}

function groupByPurpose(
  routines: RoutineDef[],
): { purpose: Purpose['kind']; label: string; icon: string; items: RoutineDef[] }[] {
  const buckets: Record<Purpose['kind'], RoutineDef[]> = {
    freeform: [],
    inbox: [],
    briefing: [],
  };
  for (const r of routines) {
    buckets[derivePurpose(r).kind].push(r);
  }
  const order: Purpose['kind'][] = ['freeform', 'inbox', 'briefing'];
  const labelByKind: Record<Purpose['kind'], { label: string; icon: string }> = {
    freeform: { label: 'Freeform', icon: '◇' },
    inbox: { label: 'Inbox sources', icon: '📥' },
    briefing: { label: 'Briefings', icon: '📰' },
  };
  return order
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({
      purpose: k,
      label: labelByKind[k].label,
      icon: labelByKind[k].icon,
      items: buckets[k],
    }));
}

function isRunning(r: RoutineDef, running: Set<string>): boolean {
  if (!r.recentTaskIds || r.recentTaskIds.length === 0) return false;
  return r.recentTaskIds.some((id) => running.has(id));
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function humanCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [m, h, dom, mon, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (
    m.startsWith('*/') &&
    h === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return `every ${m.slice(2)} min`;
  }
  if (
    m === '0' &&
    h.startsWith('*/') &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return `every ${h.slice(2)}h on the hour`;
  }
  const hourRangeOnHour =
    m === '0' && /^[\d,-]+$/.test(h) && dom === '*' && mon === '*';
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
