import { useEffect, useMemo, useState } from 'react';

import type {
  DashboardConfig,
  DashboardItem,
  DashboardSection,
  Reminder,
  RoutineDef,
  SkillSummary,
  TaskSummary,
} from '../../shared/types';
import { Inbox } from './Inbox';
import { MarkdownDoc } from './MarkdownText';
import { TaskAnswerPreview } from './TaskAnswerPreview';
import { toast } from './Toaster';

interface Props {
  tasks: TaskSummary[];
  reminders: Reminder[];
  onSelectTask: (id: string) => void;
  onCancelReminder: (id: string) => void;
}

/**
 * User-defined dashboard. The user creates sections (Inbox, My briefings,
 * …) and pins items into them. Layout config lives at
 * ~/.jarvis/dashboard.json; this view is a pure renderer with an
 * "Edit layout" toggle that exposes section + item CRUD.
 *
 * Each item kind has its own renderer:
 *   - 'inbox'   → the full Inbox component inline
 *   - 'routine' → the routine's latest output, by kind:
 *                   - briefings/*  → markdown reader for the latest .md
 *                   - inbox/*      → "N rows · view inbox" link
 *                   - freeform     → "view last transcript" link
 */
export function Dashboard(_props: Props) {
  const [config, setConfig] = useState<DashboardConfig>({ sections: [] });
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    void window.jarvis.readDashboard().then(setConfig);
    return window.jarvis.onDashboardChanged(setConfig);
  }, []);

  const save = (next: DashboardConfig) => {
    setConfig(next); // optimistic
    void window.jarvis.writeDashboard(next);
  };

  const renameSection = (id: string, title: string) =>
    save({
      sections: config.sections.map((s) =>
        s.id === id ? { ...s, title: title.trim() || 'Untitled' } : s,
      ),
    });

  const moveSection = (id: string, dir: -1 | 1) => {
    const i = config.sections.findIndex((s) => s.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= config.sections.length) return;
    const next = config.sections.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    save({ sections: next });
  };

  const deleteSection = (id: string) => {
    if (!confirm('Delete this section? Items in it are unlinked, not deleted.')) {
      return;
    }
    save({ sections: config.sections.filter((s) => s.id !== id) });
  };

  const addSection = () => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    save({
      sections: [
        ...config.sections,
        { id, title: 'New section', items: [] },
      ],
    });
  };

  const setItems = (sectionId: string, items: DashboardItem[]) =>
    save({
      sections: config.sections.map((s) =>
        s.id === sectionId ? { ...s, items } : s,
      ),
    });

  return (
    <div className="dash">
      <header className="dash__header">
        <div className="dash__title">DASHBOARD</div>
        <div className="dash__actions">
          {editing && (
            <button onClick={addSection} className="dash__add-section">
              + New section
            </button>
          )}
          <button
            className={`dash__edit${editing ? ' dash__edit--on' : ''}`}
            onClick={() => setEditing((v) => !v)}
            title={editing ? 'Done editing' : 'Add or rearrange sections'}
          >
            {editing ? '✓ Done' : '✎ Edit layout'}
          </button>
        </div>
      </header>

      {config.sections.length === 0 && (
        <div className="dash__empty">
          No sections yet.{' '}
          <button onClick={addSection} className="dash__inline-add">
            Add one
          </button>
          .
        </div>
      )}

      <div className="dash__sections">
        {config.sections.map((section, i) => (
          <SectionView
            key={section.id}
            section={section}
            editing={editing}
            isFirst={i === 0}
            isLast={i === config.sections.length - 1}
            onRename={(t) => renameSection(section.id, t)}
            onMove={(dir) => moveSection(section.id, dir)}
            onDelete={() => deleteSection(section.id)}
            onItemsChange={(items) => setItems(section.id, items)}
          />
        ))}
      </div>
    </div>
  );
}

function SectionView({
  section,
  editing,
  isFirst,
  isLast,
  onRename,
  onMove,
  onDelete,
  onItemsChange,
}: {
  section: DashboardSection;
  editing: boolean;
  isFirst: boolean;
  isLast: boolean;
  onRename: (title: string) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onItemsChange: (items: DashboardItem[]) => void;
}) {
  const [titleDraft, setTitleDraft] = useState(section.title);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setTitleDraft(section.title);
  }, [section.title]);

  const addItem = (item: DashboardItem) => {
    onItemsChange([...section.items, item]);
    setPickerOpen(false);
  };

  const removeItemAt = (idx: number) =>
    onItemsChange(section.items.filter((_, i) => i !== idx));

  return (
    <section className="dash-section">
      <header className="dash-section__head">
        {editing ? (
          <input
            className="dash-section__title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              if (titleDraft.trim() && titleDraft !== section.title) {
                onRename(titleDraft);
              } else {
                setTitleDraft(section.title);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setTitleDraft(section.title);
            }}
            spellCheck={false}
          />
        ) : (
          <h3 className="dash-section__title">{section.title}</h3>
        )}
        {editing && (
          <div className="dash-section__controls">
            <button
              onClick={() => onMove(-1)}
              disabled={isFirst}
              title="Move up"
              aria-label="Move up"
            >
              ↑
            </button>
            <button
              onClick={() => onMove(1)}
              disabled={isLast}
              title="Move down"
              aria-label="Move down"
            >
              ↓
            </button>
            <button
              onClick={onDelete}
              title="Delete section"
              aria-label="Delete section"
              className="dash-section__delete"
            >
              ×
            </button>
          </div>
        )}
      </header>

      <div className="dash-section__items">
        {section.items.length === 0 && !editing && (
          <div className="dash-section__empty">
            Empty section. Turn on <em>Edit layout</em> to add items.
          </div>
        )}
        {section.items.map((item, idx) => (
          <ItemView
            key={`${section.id}-${idx}`}
            item={item}
            editing={editing}
            onRemove={() => removeItemAt(idx)}
          />
        ))}
      </div>

      {editing && (
        <div className="dash-section__add">
          <button onClick={() => setPickerOpen((v) => !v)}>
            + Add item
          </button>
          {pickerOpen && (
            <ItemPicker existing={section.items} onPick={addItem} />
          )}
        </div>
      )}
    </section>
  );
}

function ItemView({
  item,
  editing,
  onRemove,
}: {
  item: DashboardItem;
  editing: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="dash-item">
      {editing && (
        <button
          className="dash-item__remove"
          onClick={onRemove}
          title="Remove from this section"
          aria-label="Remove item"
        >
          ×
        </button>
      )}
      {item.kind === 'inbox' && <Inbox />}
      {item.kind === 'routine' && <RoutineItem routineId={item.routineId} />}
    </div>
  );
}

/**
 * Renders a routine's latest output. Picks the renderer by inferring
 * the routine's output kind from its skill id (briefing-prefix /
 * inbox-suffix / etc.) — same heuristic Routines.tsx uses for purpose
 * chips, kept here as a local copy to avoid the cross-file dep.
 */
function RoutineItem({ routineId }: { routineId: string }) {
  const [routine, setRoutine] = useState<RoutineDef | null>(null);
  const [skill, setSkill] = useState<SkillSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const all = await window.jarvis.listRoutines();
      if (cancelled) return;
      const r = all.find((x) => x.id === routineId) ?? null;
      setRoutine(r);
      if (r) {
        const skills = await window.jarvis.listSkills();
        if (cancelled) return;
        setSkill(skills.find((s) => s.id === r.skillId) ?? null);
      }
    };
    void load();
    const off = window.jarvis.onRoutinesChanged((all) => {
      const r = all.find((x) => x.id === routineId) ?? null;
      setRoutine(r);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [routineId]);

  if (!routine) {
    return (
      <div className="dash-routine dash-routine--missing">
        Routine <code>{routineId}</code> not found. Remove this card or
        recreate the routine in the Routines tab.
      </div>
    );
  }

  const kind = inferOutputKind(routine);

  return (
    <article className="dash-routine">
      <header className="dash-routine__head">
        <div className="dash-routine__title">
          {skill?.name ?? routine.skillId}
        </div>
        <div className="dash-routine__meta">
          {routine.lastRunAt
            ? `last run · ${formatRelative(routine.lastRunAt)}`
            : 'never run'}
          {' · '}
          <button
            className="dash-routine__link"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('jarvis:navigate', { detail: { tab: 'routines' } }),
              );
            }}
            title="Open the Routines tab"
          >
            edit routine
          </button>
          {' · '}
          <button
            className="dash-routine__link"
            onClick={async () => {
              try {
                await window.jarvis.runRoutineNow(routine.id);
                toast({ message: `Fired · ${skill?.name ?? routine.skillId}` });
              } catch (e) {
                toast({
                  kind: 'error',
                  message: e instanceof Error ? e.message : String(e),
                });
              }
            }}
          >
            run now
          </button>
        </div>
      </header>
      <div className="dash-routine__body">
        {kind === 'briefing' && (
          <BriefingPreview kindId={inferBriefingKindId(routine)} />
        )}
        {kind === 'inbox-source' && (
          <div className="dash-routine__hint">
            Inbox source · view rows in the{' '}
            <button
              className="dash-routine__link"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
                )
              }
            >
              Inbox tab
            </button>
            .
          </div>
        )}
        {kind === 'freeform' && (
          routine.lastTaskId ? (
            // Show ONLY the assistant's answer — the user explicitly does
            // not want to see the full pipeline (tool calls, intermediate
            // events) on the dashboard. Compact slices long answers so
            // dashboards stay scannable; the link opens the full one.
            <TaskAnswerPreview
              taskId={routine.lastTaskId}
              compact
              openLabel="see full pipeline in Observatory →"
            />
          ) : (
            <div className="dash-routine__hint">
              No output yet. Click "run now" above to generate the first one.
            </div>
          )
        )}
      </div>
    </article>
  );
}

type OutputKind = 'briefing' | 'inbox-source' | 'freeform';

function inferOutputKind(r: RoutineDef): OutputKind {
  if (r.id.startsWith('briefing-')) return 'briefing';
  if (r.skillId.endsWith('-inbox') || r.skillId === 'calendar-today') {
    return 'inbox-source';
  }
  return 'freeform';
}

function inferBriefingKindId(r: RoutineDef): string {
  return r.id.startsWith('briefing-') ? r.id.slice('briefing-'.length) : r.id;
}

/**
 * Reads the latest briefing markdown file for a kind and renders it
 * with the same MarkdownDoc viewer Skills + Routines use. Self-
 * refreshes on briefings:changed so a freshly-fired routine updates
 * the preview without manual reload.
 */
function BriefingPreview({ kindId }: { kindId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [latestFilename, setLatestFilename] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const files = await window.jarvis.listBriefingFiles(kindId);
        if (cancelled) return;
        if (files.length === 0) {
          setContent('');
          setLatestFilename(null);
          return;
        }
        const f = files[0]!;
        setLatestFilename(f.filename);
        const body = await window.jarvis.readBriefingFile(kindId, f.filename);
        if (cancelled) return;
        setContent(body);
      } catch {
        setContent('');
      }
    };
    void refresh();
    const off = window.jarvis.onBriefingsChanged(refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, [kindId]);

  if (content === null) return <div className="dash-routine__hint">Loading…</div>;
  if (!content) {
    return (
      <div className="dash-routine__hint">
        No briefing yet. Run the routine to generate one.
      </div>
    );
  }
  return (
    <div className="dash-routine__briefing">
      {latestFilename && (
        <div className="dash-routine__file">{latestFilename}</div>
      )}
      <MarkdownDoc>{content}</MarkdownDoc>
    </div>
  );
}

/**
 * Add-item picker: lists current routines + the special 'inbox' option.
 * Hides items already in the section so the user can't add duplicates.
 */
function ItemPicker({
  existing,
  onPick,
}: {
  existing: DashboardItem[];
  onPick: (item: DashboardItem) => void;
}) {
  const [routines, setRoutines] = useState<RoutineDef[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  useEffect(() => {
    void window.jarvis.listRoutines().then(setRoutines);
    void window.jarvis.listSkills().then(setSkills);
    const off = window.jarvis.onRoutinesChanged(setRoutines);
    return off;
  }, []);

  const skillsById = useMemo(
    () => new Map(skills.map((s) => [s.id, s])),
    [skills],
  );

  const hasInbox = existing.some((it) => it.kind === 'inbox');
  const pinnedRoutineIds = new Set(
    existing
      .filter((it): it is Extract<DashboardItem, { kind: 'routine' }> => it.kind === 'routine')
      .map((it) => it.routineId),
  );
  const pickableRoutines = routines.filter((r) => !pinnedRoutineIds.has(r.id));

  return (
    <div className="dash-picker">
      {!hasInbox && (
        <button
          className="dash-picker__row"
          onClick={() => onPick({ kind: 'inbox' })}
        >
          <div className="dash-picker__name">Inbox</div>
          <div className="dash-picker__hint">All current inbox items</div>
        </button>
      )}
      {pickableRoutines.length === 0 ? (
        <div className="dash-picker__empty">
          No routines available. Create one in the Routines tab first.
        </div>
      ) : (
        pickableRoutines.map((r) => {
          const skill = skillsById.get(r.skillId);
          return (
            <button
              key={r.id}
              className="dash-picker__row"
              onClick={() => onPick({ kind: 'routine', routineId: r.id })}
            >
              <div className="dash-picker__name">
                {skill?.name ?? r.skillId}
              </div>
              <div className="dash-picker__hint">
                <code>{r.id}</code>
                {!r.enabled && ' · disabled'}
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
