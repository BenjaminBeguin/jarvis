import { useEffect, useRef, useState } from 'react';

interface ScopePickerProps {
  projects: { name: string; aliases: string[] }[];
  active: string | null;
  onChange: (next: string | null) => void;
  onCreate: () => void;
}

/**
 * Header pill that controls the "active project" scope. When a project is
 * set, free-text palette dispatches auto-prefix with "<alias>:", notes /
 * meetings default to that project, and skills load that project's memory.
 * Persisted to localStorage by the Shell so it survives a restart.
 */
export function ScopePicker({ projects, active, onChange, onCreate }: ScopePickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const label = active ?? 'All projects';

  return (
    <div className="shell__scope" ref={wrapRef}>
      <button
        className={`shell__scope-btn${active ? ' shell__scope-btn--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Active project scope"
      >
        <span className="shell__scope-dot" />
        <span className="shell__scope-label">{label}</span>
        <span className="shell__scope-caret">▾</span>
      </button>
      {open && (
        <div className="shell__scope-menu">
          <button
            className={`shell__scope-item${!active ? ' shell__scope-item--active' : ''}`}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            All projects
            <span className="shell__scope-item-hint">no scope</span>
          </button>
          {projects.length === 0 && (
            <div className="shell__scope-empty">
              No projects yet — hit "+ New project" below.
            </div>
          )}
          {projects.map((p) => (
            <button
              key={p.name}
              className={`shell__scope-item${active === p.name ? ' shell__scope-item--active' : ''}`}
              onClick={() => {
                onChange(p.name);
                setOpen(false);
              }}
              title={p.aliases.length ? `aliases: ${p.aliases.join(', ')}` : undefined}
            >
              {p.name}
              {p.aliases.length > 0 && (
                <span className="shell__scope-item-hint">{p.aliases[0]}</span>
              )}
            </button>
          ))}
          <button
            className="shell__scope-item shell__scope-item--new"
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
            title="Add a project to ~/.jarvis/projects.json"
          >
            + New project
            <span className="shell__scope-item-hint">scope</span>
          </button>
        </div>
      )}
    </div>
  );
}
