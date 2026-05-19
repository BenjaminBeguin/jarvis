import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { WorkflowDef, WorkflowRun } from '../../../shared/types';

/**
 * Floating dropdown for picking the active workflow on the
 * Workflows page. Lives in the top toolbar — replaces the old
 * left-rail list so the canvas can take the full width.
 *
 * Each menu item renders a tiny sparkline of the last ~10 runs
 * (green / red / amber blocks) so the user spots quietly-broken
 * workflows at a glance.
 */

interface Props {
  workflows: WorkflowDef[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Map of workflowId → up to 10 most-recent runs (newest first).
   *  Drives the per-row sparkline in the dropdown. */
  recentByWorkflow?: Map<string, WorkflowRun[]>;
}

function triggerLabel(t: WorkflowDef['trigger']): string {
  if (t.kind === 'cron') return `every ${t.every}`;
  if (t.kind === 'autopilot') {
    return t.when === 'cron'
      ? `autopilot · every ${t.every ?? '?'}`
      : `autopilot · on ${(t.sources ?? []).join(', ') || 'inbox'}`;
  }
  return `manual${t.palette ? ' · /' + t.palette : ''}`;
}

function statusClass(status: WorkflowRun['status']): string {
  if (status === 'completed') return 'wf-selector__spark-cell--ok';
  if (status === 'errored') return 'wf-selector__spark-cell--err';
  if (status === 'aborted') return 'wf-selector__spark-cell--abort';
  return 'wf-selector__spark-cell--running';
}

/**
 * Tiny strip of colored cells, oldest-left → newest-right. We get
 * runs newest-first from the runner; reverse so reading direction
 * matches reading order.
 */
function HealthSparkline({ runs }: { runs: WorkflowRun[] }) {
  if (runs.length === 0) return null;
  const cells = [...runs].reverse();
  const ok = runs.filter((r) => r.status === 'completed').length;
  const total = runs.length;
  return (
    <span
      className="wf-selector__spark"
      title={`${ok}/${total} successful · last ${total} run${total === 1 ? '' : 's'}`}
      aria-label={`Recent run health: ${ok}/${total} successful`}
    >
      {cells.map((r) => (
        <span
          key={r.id}
          className={`wf-selector__spark-cell ${statusClass(r.status)}`}
        />
      ))}
    </span>
  );
}

export function WorkflowSelector({
  workflows,
  selectedId,
  onSelect,
  recentByWorkflow,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = workflows.find((w) => w.id === selectedId) ?? null;

  return (
    <div className="wf-selector" ref={wrapRef}>
      <button
        type="button"
        className="wf-selector__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className="wf-selector__dot"
          style={{
            background: selected?.enabled ? 'var(--good)' : 'var(--text-faint)',
          }}
          aria-hidden
        />
        <span className="wf-selector__name">
          {selected ? selected.name : 'Pick a workflow'}
        </span>
        <span className="wf-selector__chev" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <ul className="wf-selector__menu" role="listbox">
          {workflows.length === 0 && (
            <li className="wf-selector__empty">No workflows yet.</li>
          )}
          {(() => {
            const standard = workflows.filter(
              (w) => w.trigger.kind !== 'autopilot',
            );
            const autopilot = workflows.filter(
              (w) => w.trigger.kind === 'autopilot',
            );
            const renderRow = (w: WorkflowDef): ReactElement => {
              const isActive = w.id === selectedId;
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    className={`wf-selector__item${isActive ? ' wf-selector__item--active' : ''}`}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      onSelect(w.id);
                      setOpen(false);
                    }}
                  >
                    <span
                      className="wf-selector__item-dot"
                      style={{
                        background: w.enabled
                          ? 'var(--good)'
                          : 'var(--text-faint)',
                      }}
                      aria-hidden
                    />
                    <span className="wf-selector__item-body">
                      <span className="wf-selector__item-name">{w.name}</span>
                      <span className="wf-selector__item-meta">
                        {triggerLabel(w.trigger)} · {w.pipeline.length} node
                        {w.pipeline.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    {recentByWorkflow && (
                      <HealthSparkline
                        runs={recentByWorkflow.get(w.id) ?? []}
                      />
                    )}
                  </button>
                </li>
              );
            };
            return (
              <>
                {standard.map(renderRow)}
                {autopilot.length > 0 && (
                  <>
                    <li
                      className="wf-selector__subheader"
                      role="presentation"
                      aria-hidden
                    >
                      ⚡ Autopilot scenarios
                    </li>
                    {autopilot.map(renderRow)}
                  </>
                )}
              </>
            );
          })()}
        </ul>
      )}
    </div>
  );
}
