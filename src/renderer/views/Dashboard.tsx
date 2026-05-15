import { useEffect, useMemo, useState } from 'react';

import { nextCronFire } from '../../shared/cron';
import type {
  DashboardConfig,
  DashboardItem,
  DashboardSection,
  InboxItem,
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
      {item.kind === 'calendar' && <CalendarTimeline />}
    </div>
  );
}

const COLLAPSED_ROUTINES_KEY = 'jarvis.dashboard.collapsedRoutines';

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_ROUTINES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>): void {
  try {
    window.localStorage.setItem(
      COLLAPSED_ROUTINES_KEY,
      JSON.stringify([...set]),
    );
  } catch {
    // non-fatal — collapse state is cosmetic
  }
}

/**
 * Renders a routine's latest output. Picks the renderer by inferring
 * the routine's output kind from its skill id (briefing-prefix /
 * inbox-suffix / etc.) — same heuristic Routines.tsx uses for purpose
 * chips, kept here as a local copy to avoid the cross-file dep.
 *
 * The body can be collapsed via the ▾/▸ toggle in the header; choice
 * persists per routine in localStorage so a "hidden by default" stay
 * hidden across reopens.
 */
function RoutineItem({ routineId }: { routineId: string }) {
  const [routine, setRoutine] = useState<RoutineDef | null>(null);
  const [skill, setSkill] = useState<SkillSummary | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    loadCollapsed().has(routineId),
  );

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      const set = loadCollapsed();
      if (next) set.add(routineId);
      else set.delete(routineId);
      saveCollapsed(set);
      return next;
    });
  };

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
    <article className={`dash-routine${collapsed ? ' dash-routine--collapsed' : ''}`}>
      <header className="dash-routine__head">
        <button
          className="dash-routine__title-btn"
          onClick={toggleCollapsed}
          title={collapsed ? 'Show output' : 'Hide output'}
          aria-expanded={!collapsed}
        >
          <span className="dash-routine__caret">{collapsed ? '▸' : '▾'}</span>
          <span className="dash-routine__title">
            {skill?.name ?? routine.skillId}
          </span>
        </button>
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
      {!collapsed && (
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
      )}
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
 * Unified time-sorted view: calendar events, reminders, scheduled
 * actions, and next-fire of every routine. The dashboard's "what's
 * coming up" pane — answers "what's on the calendar AND on the agent
 * docket together."
 *
 * Sources (all read directly via existing IPC, no new plumbing):
 *   - listInbox()      → inbox items with fireAt (calendar source items,
 *                        meeting reminders, etc.)
 *   - listReminders()  → pending reminders + scheduled actions
 *   - listRoutines()   → next-fire computed from cron expression
 *
 * Each item carries a `kind` so the detail panel can render
 * type-appropriate actions. Click anywhere on a row to open detail.
 */
function CalendarTimeline() {
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [routines, setRoutines] = useState<RoutineDef[]>([]);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<ScheduledItem | null>(null);

  useEffect(() => {
    void window.jarvis.listInbox().then(setInboxItems);
    void window.jarvis.listReminders().then(setReminders);
    void window.jarvis.listRoutines().then(setRoutines);
    const offInbox = window.jarvis.onInboxChanged(setInboxItems);
    const offRem = window.jarvis.onRemindersChanged(setReminders);
    const offRoute = window.jarvis.onRoutinesChanged(setRoutines);
    // Tick the "now" anchor every minute so "in 5m / starts now"
    // labels stay accurate without remounting children.
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      offInbox();
      offRem();
      offRoute();
      clearInterval(tick);
    };
  }, []);

  const items = useMemo<ScheduledItem[]>(() => {
    const out: ScheduledItem[] = [];
    // Reminders + scheduled actions
    for (const r of reminders) {
      if (r.status !== 'pending') continue;
      out.push({
        id: `rem-${r.id}`,
        kind: r.mode === 'scheduled' ? 'scheduled-action' : 'reminder',
        title: r.body,
        fireAt: r.fireAt,
        source: r.mode,
        raw: r,
      });
    }
    // Inbox items with a fireAt (calendar events, time-pressured items)
    for (const it of inboxItems) {
      if (it.fireAt == null) continue;
      // Reminders already surfaced above — inbox mirrors them as
      // source='reminders', skip to avoid duplicates.
      if (it.source === 'reminders') continue;
      out.push({
        id: `inbox-${it.id}`,
        kind: it.source === 'calendar' ? 'event' : 'inbox-task',
        title: it.title,
        subtitle: it.subtitle,
        fireAt: it.fireAt,
        url: it.url,
        source: it.source,
        raw: it,
      });
    }
    // Routines' next-fire — only show enabled ones within 7 days so the
    // timeline stays anchored to the near future.
    const horizon = now + 7 * 24 * 60 * 60 * 1000;
    for (const r of routines) {
      if (!r.enabled) continue;
      const next = nextCronFire(r.cron, now);
      if (next == null || next > horizon) continue;
      out.push({
        id: `routine-${r.id}`,
        kind: 'routine-next',
        title: r.id.replace(/^briefing-/, ''),
        subtitle: r.input || undefined,
        fireAt: next,
        source: r.skillId,
        raw: r,
      });
    }
    return out.sort((a, b) => a.fireAt - b.fireAt);
  }, [inboxItems, reminders, routines, now]);

  const groups = useMemo(() => groupByDay(items, now), [items, now]);

  if (items.length === 0) {
    return (
      <div className="dash-cal">
        <header className="dash-cal__head">
          <h3>Calendar</h3>
          <span className="dash-cal__hint">events · reminders · routines</span>
        </header>
        <div className="dash-cal__empty">
          Nothing scheduled. Calendar events show up here once a calendar
          source routine has run; reminders + routine fires appear
          automatically.
        </div>
      </div>
    );
  }

  return (
    <div className="dash-cal">
      <header className="dash-cal__head">
        <h3>Calendar</h3>
        <span className="dash-cal__hint">
          events · reminders · routines · click any row for detail
        </span>
      </header>
      <div className="dash-cal__groups">
        {groups.map((g) => (
          <section key={g.label} className="dash-cal__group">
            <div className="dash-cal__group-label">{g.label}</div>
            <ul className="dash-cal__list">
              {g.items.map((item) => (
                <ScheduledItemRow
                  key={item.id}
                  item={item}
                  now={now}
                  onClick={() => setSelected(item)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {selected && (
        <ScheduledItemDetail
          item={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

interface ScheduledItem {
  id: string;
  kind: 'event' | 'reminder' | 'scheduled-action' | 'inbox-task' | 'routine-next';
  title: string;
  subtitle?: string;
  fireAt: number;
  url?: string;
  source?: string;
  raw: InboxItem | Reminder | RoutineDef;
}

function ScheduledItemRow({
  item,
  now,
  onClick,
}: {
  item: ScheduledItem;
  now: number;
  onClick: () => void;
}) {
  const diff = item.fireAt - now;
  const soon = diff < 10 * 60 * 1000 && diff > 0;
  const past = diff < 0;
  return (
    <li>
      <button
        className={`dash-cal__row${soon ? ' dash-cal__row--soon' : ''}${past ? ' dash-cal__row--past' : ''}`}
        onClick={onClick}
      >
        <span className="dash-cal__time">{formatClockTime(item.fireAt)}</span>
        <KindBadge kind={item.kind} />
        <span className="dash-cal__title">
          {item.title}
          {item.subtitle && (
            <span className="dash-cal__sub"> · {item.subtitle}</span>
          )}
        </span>
        <span className="dash-cal__rel">{formatRel(diff)}</span>
      </button>
    </li>
  );
}

function KindBadge({ kind }: { kind: ScheduledItem['kind'] }) {
  const label = KIND_LABEL[kind];
  return (
    <span className={`dash-cal__kind dash-cal__kind--${kind}`} title={label}>
      {label}
    </span>
  );
}

const KIND_LABEL: Record<ScheduledItem['kind'], string> = {
  event: 'EVENT',
  reminder: 'REMINDER',
  'scheduled-action': 'AUTOPILOT',
  'inbox-task': 'INBOX',
  'routine-next': 'ROUTINE',
};

/**
 * Detail panel — shows the full item + kind-appropriate actions:
 *   - event: Open meeting URL, Open in source
 *   - reminder: Fire now, Cancel
 *   - scheduled-action: Fire now, Cancel
 *   - inbox-task: Open URL, Snooze
 *   - routine-next: Run now, Edit, Open output
 */
function ScheduledItemDetail({
  item,
  onClose,
}: {
  item: ScheduledItem;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta: Array<{ label: string; value: string }> = [
    { label: 'When', value: new Date(item.fireAt).toLocaleString() },
    { label: 'Type', value: KIND_LABEL[item.kind] },
  ];
  if (item.source) meta.push({ label: 'Source', value: item.source });
  if (item.url) meta.push({ label: 'URL', value: item.url });

  return (
    <div
      className="project-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="project-dialog" role="dialog">
        <header className="project-dialog__head">
          <div>
            <h2>{item.title}</h2>
            <div className="preferences-dialog__path">{KIND_LABEL[item.kind]}</div>
          </div>
          <button
            className="project-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="project-dialog__body">
          <dl className="dash-cal-detail__meta">
            {meta.map((m) => (
              <div key={m.label} className="dash-cal-detail__meta-row">
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
          {item.subtitle && (
            <p className="dash-cal-detail__body">{item.subtitle}</p>
          )}
          <ItemActions item={item} onAfter={onClose} />
        </div>
      </div>
    </div>
  );
}

function ItemActions({
  item,
  onAfter,
}: {
  item: ScheduledItem;
  onAfter: () => void;
}) {
  const buttons: Array<{ label: string; onClick: () => void; danger?: boolean }> = [];

  if (item.url) {
    buttons.push({
      label: '↗ Open URL',
      onClick: () => void window.jarvis.openExternal(item.url!),
    });
  }

  if (item.kind === 'reminder' || item.kind === 'scheduled-action') {
    const reminder = item.raw as Reminder;
    buttons.push({
      label: 'Fire now',
      onClick: async () => {
        await window.jarvis.fireReminderNow(reminder.id);
        toast({ message: 'Fired' });
        onAfter();
      },
    });
    buttons.push({
      label: 'Cancel',
      danger: true,
      onClick: async () => {
        await window.jarvis.cancelReminder(reminder.id);
        toast({ kind: 'info', message: 'Reminder cancelled' });
        onAfter();
      },
    });
  }

  if (item.kind === 'routine-next') {
    const routine = item.raw as RoutineDef;
    buttons.push({
      label: 'Run now',
      onClick: async () => {
        await window.jarvis.runRoutineNow(routine.id);
        toast({ message: `Fired · ${routine.id}` });
        onAfter();
      },
    });
    buttons.push({
      label: 'Open in Routines',
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', { detail: { tab: 'routines' } }),
        );
        onAfter();
      },
    });
  }

  if (item.kind === 'inbox-task' || item.kind === 'event') {
    buttons.push({
      label: 'Open Inbox',
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
        );
        onAfter();
      },
    });
  }

  if (buttons.length === 0) return null;
  return (
    <div className="dash-cal-detail__actions">
      {buttons.map((b) => (
        <button
          key={b.label}
          onClick={b.onClick}
          className={b.danger ? 'project-dialog__danger' : ''}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

function groupByDay(
  items: ScheduledItem[],
  now: number,
): Array<{ label: string; items: ScheduledItem[] }> {
  const today = startOfDay(now);
  const tomorrow = today + 24 * 60 * 60 * 1000;
  const weekEnd = today + 7 * 24 * 60 * 60 * 1000;
  const groups: Record<string, ScheduledItem[]> = {};
  for (const it of items) {
    let key: string;
    if (it.fireAt < today) key = 'Past';
    else if (it.fireAt < tomorrow) key = 'Today';
    else if (it.fireAt < tomorrow + 24 * 60 * 60 * 1000) key = 'Tomorrow';
    else if (it.fireAt < weekEnd) key = 'This week';
    else key = 'Later';
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(it);
  }
  const order = ['Past', 'Today', 'Tomorrow', 'This week', 'Later'];
  return order
    .filter((k) => groups[k])
    .map((k) => ({ label: k, items: groups[k]! }));
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRel(diffMs: number): string {
  const abs = Math.abs(diffMs);
  const m = Math.round(abs / 60_000);
  const h = Math.round(m / 60);
  const d = Math.round(h / 24);
  let s: string;
  if (m < 1) s = 'now';
  else if (m < 60) s = `${m}m`;
  else if (h < 24) s = `${h}h`;
  else s = `${d}d`;
  return diffMs < 0 ? `${s} ago` : `in ${s}`;
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
  const hasCalendar = existing.some((it) => it.kind === 'calendar');
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
      {!hasCalendar && (
        <button
          className="dash-picker__row"
          onClick={() => onPick({ kind: 'calendar' })}
        >
          <div className="dash-picker__name">Calendar</div>
          <div className="dash-picker__hint">
            Events · reminders · routine fires, time-sorted
          </div>
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
