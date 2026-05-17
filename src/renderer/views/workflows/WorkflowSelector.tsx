import { useEffect, useRef, useState } from 'react';

import type { WorkflowDef } from '../../../shared/types';

/**
 * Floating dropdown for picking the active workflow on the
 * Workflows page. Lives in the top toolbar — replaces the old
 * left-rail list so the canvas can take the full width.
 */

interface Props {
  workflows: WorkflowDef[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function triggerLabel(t: WorkflowDef['trigger']): string {
  if (t.kind === 'cron') return `every ${t.every}`;
  return `manual${t.palette ? ' · /' + t.palette : ''}`;
}

export function WorkflowSelector({ workflows, selectedId, onSelect }: Props) {
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
          {workflows.map((w) => {
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
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
