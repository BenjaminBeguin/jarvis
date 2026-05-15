import { useEffect, useRef, useState } from 'react';

interface ScopePickerProps {
  projects: { name: string; aliases: string[]; path?: string }[];
  active: string | null;
  onChange: (next: string | null) => void;
  onCreate: () => void;
  /** Open the full Projects view — used as the "See all projects"
   * entry, since the Projects tab moved into this dropdown. */
  onManage: () => void;
}

/**
 * Header pill that controls the "active project" scope. When a project is
 * set, free-text palette dispatches auto-prefix with "<alias>:", notes /
 * meetings default to that project, and skills load that project's memory.
 * Persisted to localStorage by the Shell so it survives a restart.
 */
export function ScopePicker({
  projects,
  active,
  onChange,
  onCreate,
  onManage,
}: ScopePickerProps) {
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
  const activeDef = active ? projects.find((p) => p.name === active) : null;
  // Tooltip on the header button — show the path so the user knows where
  // tasks will land without having to open the dropdown.
  const buttonTitle = active
    ? activeDef?.path
      ? `Scope: ${active} · tasks run in ${activeDef.path}`
      : `Scope: ${active} · no path set (tasks run in ~)`
    : 'Click to pick a project scope';

  return (
    <div className="shell__scope" ref={wrapRef}>
      <button
        className={`shell__scope-btn${active ? ' shell__scope-btn--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={buttonTitle}
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
              title={
                p.path
                  ? `${p.path}${p.aliases.length ? ` · aliases: ${p.aliases.join(', ')}` : ''}`
                  : 'No path set in projects.json — tasks will run in ~'
              }
            >
              {p.name}
              <span className="shell__scope-item-hint">
                {p.path ? p.aliases[0] ?? 'set' : 'no path'}
              </span>
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
          <button
            className="shell__scope-item shell__scope-item--manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            title="Open the full Projects view — edit aliases, paths, memory"
          >
            See all projects
            <span className="shell__scope-item-hint">manage</span>
          </button>
        </div>
      )}
    </div>
  );
}
