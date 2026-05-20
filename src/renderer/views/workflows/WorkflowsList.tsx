import type { WorkflowDef, WorkflowRun } from '../../../shared/types';

/**
 * Index page — lists every workflow as a row. Click anywhere on a
 * row to open its detail page (graph + dock); click the inline
 * toggle to enable / disable the trigger without leaving the list.
 *
 * Rows are grouped: standard workflows (cron / manual) first, then
 * autopilot scenarios under a subheader. Inside each group rows
 * sort by name. Same grouping as the previous WorkflowSelector
 * dropdown so the user's mental map carries over.
 */

export interface WorkflowsListProps {
  workflows: WorkflowDef[];
  /** Recent runs per workflow (newest-first), drives the health
   *  sparkline at the right of each row. */
  recentByWorkflow?: Map<string, WorkflowRun[]>;
  onSelect: (id: string) => void;
  onToggle: (workflow: WorkflowDef, next: boolean) => void;
}

export function WorkflowsList({
  workflows,
  recentByWorkflow,
  onSelect,
  onToggle,
}: WorkflowsListProps) {
  if (workflows.length === 0) {
    return (
      <div className="wf-list wf-list--empty">
        No workflows. Built-ins live under{' '}
        <code>~/.jarvis/workflows/</code>; drop a new JSON file there
        and it shows up here.
      </div>
    );
  }

  const sorted = [...workflows].sort((a, b) => a.name.localeCompare(b.name));
  const standard = sorted.filter((w) => w.trigger.kind !== 'autopilot');
  const autopilot = sorted.filter((w) => w.trigger.kind === 'autopilot');

  return (
    <div className="wf-list">
      <div className="wf-list__group">
        {standard.map((w) => (
          <WorkflowRow
            key={w.id}
            workflow={w}
            recentRuns={recentByWorkflow?.get(w.id) ?? []}
            onSelect={() => onSelect(w.id)}
            onToggle={(next) => onToggle(w, next)}
          />
        ))}
      </div>
      {autopilot.length > 0 && (
        <>
          <h3 className="wf-list__subheader">⚡ Autopilot scenarios</h3>
          <div className="wf-list__group">
            {autopilot.map((w) => (
              <WorkflowRow
                key={w.id}
                workflow={w}
                recentRuns={recentByWorkflow?.get(w.id) ?? []}
                onSelect={() => onSelect(w.id)}
                onToggle={(next) => onToggle(w, next)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function WorkflowRow({
  workflow: w,
  recentRuns,
  onSelect,
  onToggle,
}: {
  workflow: WorkflowDef;
  recentRuns: WorkflowRun[];
  onSelect: () => void;
  onToggle: (next: boolean) => void;
}) {
  const trigger = triggerLabel(w.trigger);
  const ok = recentRuns.filter((r) => r.status === 'completed').length;
  return (
    <article
      className={`wf-list__row${w.enabled ? '' : ' wf-list__row--off'}`}
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
        className={`wf-list__dot wf-list__dot--${w.trigger.kind}${w.enabled ? ' wf-list__dot--on' : ''}`}
        aria-hidden
      />
      <div className="wf-list__main">
        <div className="wf-list__head">
          <span className="wf-list__name">{w.name}</span>
          <span className="wf-list__meta">
            {trigger} · {w.pipeline.length} node
            {w.pipeline.length === 1 ? '' : 's'}
          </span>
        </div>
        {w.description && (
          <div className="wf-list__desc">{w.description}</div>
        )}
        {recentRuns.length > 0 && (
          <div
            className="wf-list__health"
            title={`${ok}/${recentRuns.length} successful · last ${recentRuns.length} run${recentRuns.length === 1 ? '' : 's'}`}
          >
            {[...recentRuns].reverse().map((r) => (
              <span
                key={r.id}
                className={`wf-list__health-cell wf-list__health-cell--${r.status}`}
              />
            ))}
          </div>
        )}
      </div>
      <div
        className="wf-list__actions"
        onClick={(e) => e.stopPropagation()}
      >
        <label
          className="toggle"
          title={w.enabled ? 'Disable trigger' : 'Enable trigger'}
        >
          <input
            type="checkbox"
            checked={w.enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          {w.enabled ? 'on' : 'off'}
        </label>
        <span className="wf-list__chev" aria-hidden>
          →
        </span>
      </div>
    </article>
  );
}

function triggerLabel(t: WorkflowDef['trigger']): string {
  if (t.kind === 'cron') return `cron · ${t.every}`;
  if (t.kind === 'autopilot') {
    return t.when === 'cron'
      ? `autopilot · cron ${t.every ?? '?'}`
      : `autopilot · on ${(t.sources ?? []).join(', ') || 'inbox'}`;
  }
  return `manual${t.palette ? ' · /' + t.palette : ''}`;
}
