import { useEffect, useMemo, useState } from 'react';

import type { RoutineDef } from '../../shared/types';

import { MarkdownText } from './MarkdownText';
import { toast } from './Toaster';

interface DigestKind {
  id: string;
  label: string;
  description: string;
  skillId: string;
  schedule?: string;
}

/**
 * A briefing kind is auto-generated when there's a routine with this
 * id pointing at the kind's skill. Stable per-kind so toggling on/off
 * is idempotent.
 */
function routineIdForKind(kindId: string): string {
  return `briefing-${kindId}`;
}

interface DigestFile {
  kind: string;
  filename: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  title: string;
  date: string | null;
}

/**
 * Generated-document collection viewer. Lists kinds in the left rail
 * (daily recap, weekly retro, today's focus), files for the selected
 * kind in a middle column, rendered markdown in the right panel.
 *
 * Skills generate new files into `~/.jarvis/briefings/<kind-id>/`;
 * the view auto-refreshes via `onBriefingsChanged`. Manual "Generate
 * now" button on each kind fires the skill on demand for the user
 * who doesn't want to wait for the cron.
 *
 * Reusable: the same view shape works for any future doc collection
 * — just register new DigestKinds in main.
 */
export function Briefings() {
  const [kinds, setKinds] = useState<DigestKind[]>([]);
  const [activeKind, setActiveKind] = useState<string | null>(null);
  const [files, setFiles] = useState<DigestFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [routines, setRoutines] = useState<RoutineDef[]>([]);

  useEffect(() => {
    void window.jarvis.listBriefingKinds().then((list) => {
      setKinds(list);
      if (list.length > 0) {
        setActiveKind((cur) => cur ?? list[0]!.id);
      }
    });
  }, []);

  // Track routines so we can show + edit the schedule for each kind.
  useEffect(() => {
    void window.jarvis.listRoutines().then(setRoutines);
    return window.jarvis.onRoutinesChanged(setRoutines);
  }, []);

  // Refresh files when the active kind changes OR when a generation
  // lands a new file (the briefings:changed broadcast covers both).
  useEffect(() => {
    if (!activeKind) return;
    const refresh = () => {
      void window.jarvis.listBriefingFiles(activeKind).then((list) => {
        setFiles(list);
        // Auto-select the newest file unless the user has one selected
        // that still exists.
        if (list.length === 0) {
          setActiveFile(null);
          setContent('');
        } else {
          setActiveFile((cur) =>
            cur && list.find((f) => f.filename === cur) ? cur : list[0]!.filename,
          );
        }
      });
    };
    refresh();
    return window.jarvis.onBriefingsChanged(refresh);
  }, [activeKind]);

  // Load the selected file's content.
  useEffect(() => {
    if (!activeKind || !activeFile) {
      setContent('');
      return;
    }
    void window.jarvis
      .readBriefingFile(activeKind, activeFile)
      .then(setContent);
  }, [activeKind, activeFile]);

  const activeKindMeta = useMemo(
    () => kinds.find((k) => k.id === activeKind) ?? null,
    [kinds, activeKind],
  );

  const generateNow = async () => {
    if (!activeKind) return;
    setGenerating(true);
    try {
      const summary = await window.jarvis.generateBriefing(activeKind);
      void window.jarvis.showAnswerHud(summary.id);
      toast({ message: `Generating ${activeKindMeta?.label ?? activeKind}…` });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className="briefings">
      <aside className="briefings__rail">
        <h2 className="briefings__rail-head">BRIEFINGS</h2>
        <p className="briefings__rail-hint">
          Generated digests with citations. Each kind below is a{' '}
          <strong>skill</strong> (the prompt that pulls from meetings,
          PRs, Linear, notes) plus a <strong>routine</strong> (the
          schedule). Files land at <code>~/.jarvis/briefings/&lt;kind&gt;/</code>.
        </p>
        {kinds.map((k) => {
          const r = routines.find((x) => x.id === routineIdForKind(k.id));
          const scheduled = r?.enabled === true;
          return (
            <button
              key={k.id}
              className={`briefings__kind${k.id === activeKind ? ' briefings__kind--active' : ''}`}
              onClick={() => setActiveKind(k.id)}
            >
              <div className="briefings__kind-label">
                {scheduled && <span className="briefings__kind-on-dot" title="Scheduled auto-generation" />}
                {k.label}
              </div>
              <div className="briefings__kind-desc">{k.description}</div>
              <div className="briefings__kind-schedule">
                {scheduled ? (
                  <>
                    auto: <code>{r.cron}</code>
                  </>
                ) : (
                  <>
                    not scheduled · suggested <code>{k.schedule ?? '—'}</code>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </aside>

      <main className="briefings__main">
        {!activeKind && (
          <div className="briefings__placeholder">Pick a kind on the left.</div>
        )}
        {activeKind && activeKindMeta && (
          <>
            <header className="briefings__main-head">
              <div>
                <h3 className="briefings__main-title">
                  {activeKindMeta?.label ?? activeKind}
                </h3>
                <div className="briefings__main-hint">
                  {files.length} saved · skill <code>{activeKindMeta?.skillId}</code>
                </div>
              </div>
              <button
                className="briefings__generate"
                onClick={() => void generateNow()}
                disabled={generating}
                title="Run the skill now — produces a new file in ~/.jarvis/briefings/<kind>/"
              >
                {generating ? 'Launching…' : '✨ Generate now'}
              </button>
            </header>

            <SchedulePanel
              kind={activeKindMeta}
              routine={routines.find((r) => r.id === routineIdForKind(activeKindMeta.id)) ?? null}
            />

            <div className="briefings__panes">
              <aside className="briefings__files">
                {files.length === 0 && (
                  <div className="briefings__empty">
                    Nothing generated yet.
                    <br />
                    <br />
                    Click <strong>✨ Generate now</strong> to produce the
                    first one, or wire a routine in{' '}
                    <code>~/.jarvis/routines.json</code> on the suggested
                    cron above.
                  </div>
                )}
                {files.map((f) => (
                  <button
                    key={f.filename}
                    className={`briefings__file${
                      f.filename === activeFile ? ' briefings__file--active' : ''
                    }`}
                    onClick={() => setActiveFile(f.filename)}
                    title={f.path}
                  >
                    <div className="briefings__file-title">{f.title}</div>
                    <div className="briefings__file-meta">
                      {f.date ?? new Date(f.mtimeMs).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </aside>

              <BriefingContentPane
                kindId={activeKind}
                filename={activeFile}
                content={content}
                onContentChange={setContent}
              />
            </div>
          </>
        )}
      </main>
    </section>
  );
}

/**
 * Schedule strip — toggles auto-generation, shows the cron + last run,
 * and lets the user edit the schedule inline. Backed by the routine
 * with id `briefing-<kindId>`.
 */
function SchedulePanel({
  kind,
  routine,
}: {
  kind: DigestKind;
  routine: RoutineDef | null;
}) {
  const [busy, setBusy] = useState(false);

  const enabled = routine?.enabled === true;
  const id = routineIdForKind(kind.id);

  const enable = async () => {
    setBusy(true);
    try {
      await window.jarvis.saveRoutine({
        id,
        skillId: kind.skillId,
        cron: routine?.cron ?? kind.schedule ?? '0 8 * * *',
        input: `Generate the ${kind.label.toLowerCase()} now and save it under ~/.jarvis/briefings/${kind.id}/.`,
        enabled: true,
      });
      toast({ message: `Scheduled · ${kind.label}` });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      await window.jarvis.runRoutineNow(id);
      toast({ message: 'Routine fired' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const jumpToRoutines = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', { detail: { tab: 'routines' } }),
    );
  };

  const jumpToSkill = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', {
        detail: { tab: 'skills', skillId: kind.skillId },
      }),
    );
  };

  const skillLink = (
    <button
      className="briefings__schedule-link"
      onClick={jumpToSkill}
      title={`Open ${kind.skillId} in the Skills tab`}
    >
      {kind.skillId}
    </button>
  );

  if (!routine) {
    return (
      <>
        <div className="briefings__schedule">
          <div className="briefings__schedule-status">
            <span className="briefings__schedule-dot briefings__schedule-dot--off" />
            <span className="briefings__schedule-label">Not scheduled</span>
            <span className="briefings__schedule-hint">
              suggested: <code>{kind.schedule ?? '0 8 * * *'}</code> · uses skill{' '}
              {skillLink}
            </span>
          </div>
          <button
            className="briefings__schedule-primary"
            onClick={() => void enable()}
            disabled={busy}
            title="Add a routine that fires this skill on the suggested cron"
          >
            Enable schedule
          </button>
        </div>
      </>
    );
  }

  return (
    <>
    <div className="briefings__schedule">
      <div className="briefings__schedule-status">
        <span
          className={`briefings__schedule-dot${enabled ? ' briefings__schedule-dot--on' : ' briefings__schedule-dot--off'}`}
        />
        <span className="briefings__schedule-label">
          {enabled ? 'Scheduled' : 'Disabled'}
        </span>
        <code className="briefings__schedule-cron" title="Cron expression">
          {routine.cron}
        </code>
        <span className="briefings__schedule-hint">
          {routine.lastRunAt
            ? `last run ${formatRelative(routine.lastRunAt)}`
            : 'never run'}
          {' · skill '}{skillLink}
        </span>
      </div>
      <div className="briefings__schedule-actions">
        <button onClick={() => void runNow()} disabled={busy} title="Fire the routine right now">
          Run now
        </button>
        <button
          className="briefings__schedule-link"
          onClick={jumpToRoutines}
          title={`Edit cron, disable, or delete in Routines · ${routine.id}`}
        >
          ⚙ Manage in Routines →
        </button>
      </div>
    </div>
    </>
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

/**
 * Reading + editing pane for a single briefing markdown file.
 * Toggles between rendered MarkdownText and a raw textarea editor.
 * Save persists via writeBriefingFile; chokidar broadcast triggers
 * the rest of the UI to refresh.
 */
function BriefingContentPane({
  kindId,
  filename,
  content,
  onContentChange,
}: {
  kindId: string;
  filename: string | null;
  content: string;
  onContentChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(content);
  }, [content]);

  // Switching to a different file cancels any in-progress edit so
  // the user doesn't accidentally save Mon's text over Tue's.
  useEffect(() => {
    setEditing(false);
  }, [filename]);

  const save = async () => {
    if (!filename) return;
    setSaving(true);
    try {
      await window.jarvis.writeBriefingFile(kindId, filename, draft);
      onContentChange(draft);
      setEditing(false);
      toast({ message: 'Briefing saved' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!filename) {
    return (
      <article className="briefings__content">
        <div className="briefings__empty">Pick a file on the left.</div>
      </article>
    );
  }

  return (
    <article className="briefings__content">
      <div className="briefings__content-actions">
        {!editing ? (
          <button
            className="briefings__content-edit"
            onClick={() => setEditing(true)}
            title="Edit the markdown"
          >
            ✎ Edit
          </button>
        ) : (
          <>
            <button
              className="briefings__content-edit"
              onClick={() => {
                setDraft(content);
                setEditing(false);
              }}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="briefings__content-save"
              onClick={() => void save()}
              disabled={saving || draft === content}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
      {editing ? (
        <textarea
          className="briefings__content-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoFocus
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              void save();
            }
          }}
        />
      ) : content ? (
        <MarkdownText>{content}</MarkdownText>
      ) : (
        <div className="briefings__empty">Loading…</div>
      )}
    </article>
  );
}

