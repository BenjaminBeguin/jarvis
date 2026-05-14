import { useEffect, useMemo, useState } from 'react';

import type {
  ProjectDef,
  ProjectMemoryFile,
} from '../../../shared/types';
import { MarkdownText } from '../MarkdownText';
import { formatRelative } from '../TaskList';
import { toast } from '../Toaster';

/**
 * Project memory visualization. Each project becomes a glowing core
 * with its memory files orbiting as nodes — same visual vocabulary as
 * the observatory constellation, but scoped to one project. Click a
 * memory node to slide in the markdown content.
 *
 * Layout:
 *   - Left rail: project picker (cards with name + memory file count).
 *   - Main: selected project's "memory constellation" — core + orbits.
 *   - Slide-in panel: when a memory file is selected, its contents
 *     render to the right, scrollable, fully selectable.
 */
export function Projects() {
  const [projects, setProjects] = useState<ProjectDef[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [memory, setMemory] = useState<ProjectMemoryFile[]>([]);
  const [memoryCounts, setMemoryCounts] = useState<Record<string, number>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void window.jarvis.listProjects().then((list) => {
      setProjects(list);
      if (!activeProject && list.length > 0) {
        setActiveProject(list[0]!.name);
      }
    });
  }, []);

  // Per-project memory counts for the picker badges.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const counts: Record<string, number> = {};
      for (const p of projects) {
        try {
          const files = await window.jarvis.listProjectMemory(p.name);
          counts[p.name] = files.length;
        } catch {
          counts[p.name] = 0;
        }
      }
      if (!cancelled) setMemoryCounts(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  // Load the active project's memory.
  useEffect(() => {
    if (!activeProject) {
      setMemory([]);
      setSelectedFile(null);
      return;
    }
    void window.jarvis.listProjectMemory(activeProject).then(setMemory);
    setSelectedFile(null);
    setContent('');
    setEditing(false);
  }, [activeProject]);

  // Load file content when a memory node is selected.
  useEffect(() => {
    if (!activeProject || !selectedFile) {
      setContent('');
      return;
    }
    void window.jarvis
      .readProjectMemory(activeProject, selectedFile)
      .then((c) => {
        setContent(c);
        setDraft(c);
        setEditing(false);
      });
  }, [activeProject, selectedFile]);

  const activeDef = useMemo(
    () => projects.find((p) => p.name === activeProject),
    [projects, activeProject],
  );

  const onSave = async () => {
    if (!activeProject || !selectedFile) return;
    try {
      await window.jarvis.writeProjectMemory(activeProject, selectedFile, draft);
      setContent(draft);
      setEditing(false);
      toast({ message: `Memory saved · ${selectedFile}` });
      // Refresh list so mtime updates and the orbit sort is correct.
      const next = await window.jarvis.listProjectMemory(activeProject);
      setMemory(next);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onDelete = async () => {
    if (!activeProject || !selectedFile) return;
    if (!confirm(`Delete memory file "${selectedFile}"? This can't be undone.`))
      return;
    const ok = await window.jarvis.deleteProjectMemory(activeProject, selectedFile);
    if (!ok) {
      toast({ kind: 'error', message: 'Delete failed' });
      return;
    }
    toast({ kind: 'info', message: 'Memory deleted' });
    setSelectedFile(null);
    const next = await window.jarvis.listProjectMemory(activeProject);
    setMemory(next);
  };

  return (
    <section className="projects">
      <aside className="projects__rail">
        <header className="projects__rail-head">
          <h2>PROJECTS</h2>
          <p>
            Persistent memory grows here as agents work on each codebase.
            Markdown, editable.
          </p>
        </header>
        {projects.length === 0 && (
          <div className="projects__empty">
            No projects yet. Edit{' '}
            <code>~/.jarvis/projects.json</code> (or copy the{' '}
            <code>.example</code>) and they'll show up here.
          </div>
        )}
        <ul className="projects__list">
          {projects.map((p) => {
            const count = memoryCounts[p.name] ?? 0;
            return (
              <li key={p.name}>
                <button
                  className={`project-card${
                    p.name === activeProject ? ' project-card--active' : ''
                  }`}
                  onClick={() => setActiveProject(p.name)}
                >
                  <div className="project-card__name">{p.name}</div>
                  {p.repo && <div className="project-card__repo">{p.repo}</div>}
                  {p.description && (
                    <div className="project-card__desc">{p.description}</div>
                  )}
                  <div className="project-card__meta">
                    <span>{count} memory file{count === 1 ? '' : 's'}</span>
                    {p.aliases.length > 0 && (
                      <span>· {p.aliases.length} alias{p.aliases.length === 1 ? '' : 'es'}</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="projects__main">
        {activeDef ? (
          <MemoryConstellation
            project={activeDef}
            memory={memory}
            selectedFile={selectedFile}
            onSelect={setSelectedFile}
          />
        ) : (
          <div className="projects__placeholder">
            Pick a project on the left.
          </div>
        )}

        {activeProject && selectedFile && (
          <aside className="projects__panel">
            <header className="projects__panel-head">
              <div>
                <div className="projects__panel-name">{selectedFile}</div>
                <div className="projects__panel-meta">
                  {memory.find((m) => m.name === selectedFile) && (
                    <>
                      Last updated{' '}
                      {formatRelative(
                        memory.find((m) => m.name === selectedFile)!.mtimeMs,
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="projects__panel-actions">
                {!editing && (
                  <button onClick={() => setEditing(true)}>Edit</button>
                )}
                {editing && (
                  <>
                    <button
                      onClick={() => {
                        setDraft(content);
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="projects__panel-save"
                      onClick={() => void onSave()}
                    >
                      Save
                    </button>
                  </>
                )}
                <button
                  className="projects__panel-delete"
                  onClick={() => void onDelete()}
                  title="Delete this memory file"
                >
                  ×
                </button>
                <button
                  className="projects__panel-close"
                  onClick={() => setSelectedFile(null)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </header>
            <div className="projects__panel-body">
              {editing ? (
                <textarea
                  className="projects__panel-textarea"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  autoFocus
                />
              ) : content ? (
                <MarkdownText>{content}</MarkdownText>
              ) : (
                <div className="projects__panel-empty">_(empty file)_</div>
              )}
            </div>
          </aside>
        )}
      </main>
    </section>
  );
}

interface MemoryConstellationProps {
  project: ProjectDef;
  memory: ProjectMemoryFile[];
  selectedFile: string | null;
  onSelect: (file: string) => void;
}

/**
 * SVG constellation per project. Project name at center, memory files
 * orbit as nodes. Newest memory file = innermost ring + largest dot;
 * older files float farther out + smaller.
 */
function MemoryConstellation({
  project,
  memory,
  selectedFile,
  onSelect,
}: MemoryConstellationProps) {
  const CENTER = { x: 500, y: 500 };
  // Stable layout: sort newest-first, place around concentric rings.
  const placements = useMemo(() => {
    if (memory.length === 0) return [];
    const sorted = [...memory].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const innerR = 150;
    const stepR = 65;
    return sorted.map((m, i) => {
      // Rotate around the core; alternate angle to spread out.
      const ringIdx = Math.floor(i / 6);
      const inRing = i % 6;
      const angle =
        (-Math.PI / 2) + (inRing * 2 * Math.PI) / 6 + ringIdx * 0.32;
      const r = innerR + ringIdx * stepR;
      return {
        file: m,
        x: CENTER.x + Math.cos(angle) * r,
        y: CENTER.y + Math.sin(angle) * r,
        angle,
        r,
        size: Math.max(6, 14 - ringIdx * 2),
        labelOffset: 22,
      };
    });
  }, [memory]);

  const newestTouchMs = memory.length > 0
    ? Math.max(...memory.map((m) => m.mtimeMs))
    : null;

  return (
    <div className="memory-constellation">
      <svg
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid meet"
        className="memory-constellation__svg"
      >
        <defs>
          <radialGradient id="mem-core-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,212,255,0.65)" />
            <stop offset="60%" stopColor="rgba(0,212,255,0.08)" />
            <stop offset="100%" stopColor="rgba(0,212,255,0)" />
          </radialGradient>
          <radialGradient id="mem-node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,212,255,0.45)" />
            <stop offset="100%" stopColor="rgba(0,212,255,0)" />
          </radialGradient>
        </defs>

        {/* Faint orbital rings — give the eye structure even with 0 nodes. */}
        <g className="memory-constellation__rings">
          {[150, 215, 280, 345].map((r, i) => (
            <circle key={i} cx={CENTER.x} cy={CENTER.y} r={r} />
          ))}
        </g>

        {/* Core — project name. */}
        <g className="memory-constellation__core">
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={110}
            fill="url(#mem-core-glow)"
          />
          <circle cx={CENTER.x} cy={CENTER.y} r={76} className="memory-constellation__halo" />
          <circle cx={CENTER.x} cy={CENTER.y} r={64} className="memory-constellation__disc" />
          <text
            x={CENTER.x}
            y={CENTER.y - 8}
            textAnchor="middle"
            className="memory-constellation__name"
          >
            {project.name.toUpperCase()}
          </text>
          <text
            x={CENTER.x}
            y={CENTER.y + 14}
            textAnchor="middle"
            className="memory-constellation__count"
          >
            {memory.length} MEMORY · {memory.length === 0 ? 'EMPTY' : ''}
            {newestTouchMs &&
              `${memory.length === 0 ? '' : 'touched '}${formatRelative(newestTouchMs)}`}
          </text>
        </g>

        {/* Memory nodes. */}
        <g className="memory-constellation__nodes">
          {placements.map((p) => {
            const isSelected = p.file.name === selectedFile;
            const labelX =
              CENTER.x + Math.cos(p.angle) * (p.r + p.labelOffset);
            const labelY =
              CENTER.y + Math.sin(p.angle) * (p.r + p.labelOffset);
            const anchor =
              Math.cos(p.angle) > 0.2
                ? 'start'
                : Math.cos(p.angle) < -0.2
                ? 'end'
                : 'middle';
            return (
              <g
                key={p.file.name}
                className={`memory-node${
                  isSelected ? ' memory-node--selected' : ''
                }`}
                onClick={() => onSelect(p.file.name)}
                style={{ cursor: 'pointer' }}
              >
                <circle cx={p.x} cy={p.y} r={26} fill="url(#mem-node-glow)" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={p.size}
                  className="memory-node__disc"
                />
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  className="memory-node__label"
                >
                  {p.file.name.replace(/\.md$/, '')}
                </text>
              </g>
            );
          })}
        </g>

        {memory.length === 0 && (
          <text
            x={CENTER.x}
            y={770}
            textAnchor="middle"
            className="memory-constellation__standby"
          >
            NO MEMORY YET · AGENTS WILL POPULATE AS THEY WORK
          </text>
        )}
      </svg>
    </div>
  );
}
