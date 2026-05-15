import { useEffect, useState } from 'react';

import type { JarvisFileEntry } from '../../shared/types';
import { TaskBindingBadge } from '../views/TaskBindingBadge';
import { toast } from '../views/Toaster';
import { useTaskBinding } from '../views/useTaskBinding';

interface NoteEntry {
  time: string;
  body: string;
  /** 0-based index in file order — used by the delete IPC to splice. */
  fileIndex: number;
  /** True if the entry has a jarvis:archived marker. Archived entries
   * are hidden from the active list and surfaced in the Archived
   * section. The marker is stripped from `body` for display. */
  archived: boolean;
  /** ISO timestamp from the archive marker, if present. */
  archivedAt?: string;
}

interface NoteFile {
  date: string;
  mtimeMs: number;
  entries: NoteEntry[];
  raw: string;
}

const ARCHIVE_MARKER_RX = /<!-- jarvis:archived:([^>]*?)-->\n/;

function parseEntries(raw: string): NoteEntry[] {
  // The file is appended as: "\n## HH:MM\n\n<text>\n" — split on those
  // headers so we can offer per-entry actions without throwing away the
  // original markdown. Keep file-order index so deletion can splice.
  const entries: NoteEntry[] = [];
  const re = /(?:^|\n)## (\d{2}:\d{2})\n([\s\S]*?)(?=\n## \d{2}:\d{2}|$)/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(raw)) !== null) {
    const time = m[1];
    let body = m[2].trim();
    let archived = false;
    let archivedAt: string | undefined;
    const marker = body.match(ARCHIVE_MARKER_RX);
    if (marker) {
      archived = true;
      archivedAt = marker[1]!.trim();
      body = body.replace(ARCHIVE_MARKER_RX, '').trim();
    }
    if (body) entries.push({ time, body, fileIndex: i, archived, archivedAt });
    i++;
  }
  return entries.reverse(); // newest first within the day
}

function dateLabel(iso: string): string {
  const [y, mo, d] = iso.split('-').map((v) => parseInt(v, 10));
  if (!y || !mo || !d) return iso;
  return new Date(y, mo - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

const PUSH_PROMPT_PREFIX =
  'I jotted this down earlier — help me act on it. If it looks like a question, answer it. If it looks like a task, propose the next concrete step and offer to do it.\n\n';

export function QuickNotePage({ compact = false }: { compact?: boolean } = {}) {
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState<string | null>(null);
  const bindings = useTaskBinding('notes');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const entries: JarvisFileEntry[] = await window.jarvis.listJarvisDir('notes');
      const mdFiles = entries
        .filter((e) => !e.isDir && e.name.endsWith('.md'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const loaded = await Promise.all(
        mdFiles.map(async (entry) => {
          const raw = await window.jarvis.readJarvisFile(`notes/${entry.name}`);
          return {
            date: entry.name.replace(/\.md$/, ''),
            mtimeMs: entry.mtimeMs,
            entries: parseEntries(raw),
            raw,
          };
        }),
      );
      setFiles(loaded);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const pushEntry = async (key: string, body: string) => {
    setPushing(key);
    try {
      const summary = await window.jarvis.launchTask({
        prompt: `${PUSH_PROMPT_PREFIX}${body}`,
        origin: 'palette',
      });
      bindings.bind(key, summary.id);
      void window.jarvis.showAnswerHud(summary.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(null);
    }
  };

  /**
   * Soft-archive: × on an active note routes here. The entry stays on
   * disk with a marker so the Archived section can show + restore it.
   * Permanent removal is `permaDeleteEntry` (used only from inside the
   * Archived section).
   */
  const archiveEntry = async (date: string, entry: NoteEntry) => {
    try {
      const r = await window.jarvis.setNoteEntryArchived(
        date,
        entry.fileIndex,
        true,
      );
      if (!r.ok) {
        setError(r.message ?? 'Could not archive.');
        toast({ kind: 'error', message: r.message ?? 'Could not archive note.' });
        return;
      }
      toast({ message: 'Note archived · view under "Archived"' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const restoreEntry = async (date: string, entry: NoteEntry) => {
    try {
      const r = await window.jarvis.setNoteEntryArchived(
        date,
        entry.fileIndex,
        false,
      );
      if (!r.ok) {
        setError(r.message ?? 'Could not restore.');
        toast({ kind: 'error', message: r.message ?? 'Could not restore note.' });
        return;
      }
      toast({ message: 'Note restored' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const permaDeleteEntry = async (date: string, entry: NoteEntry) => {
    const preview =
      entry.body.length > 60 ? `${entry.body.slice(0, 60)}…` : entry.body;
    if (!confirm(`Permanently delete this archived note from ${date} ${entry.time}?\n\n"${preview}"\n\nThis can't be undone.`)) return;
    try {
      const r = await window.jarvis.deleteNoteEntry(date, entry.fileIndex);
      if (!r.ok) {
        setError(r.message ?? 'Could not delete.');
        toast({ kind: 'error', message: r.message ?? 'Could not delete note.' });
        return;
      }
      toast({ kind: 'info', message: 'Note deleted' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`module-page${compact ? ' module-page--compact' : ''}`}>
      {!compact && (
      <header className="module-page__header">
        <div>
          <h2>NOTES</h2>
          <p>
            Type <code>/note &lt;text&gt;</code> in the palette · saved to{' '}
            <code>~/.jarvis/notes/</code>
          </p>
        </div>
        <button onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </header>
      )}

      {error && <div className="module-page__error">{error}</div>}

      {!loading && files.length === 0 && (
        <div className="module-page__empty">
          No notes yet. Hit ⌘⇧J and try <code>/note hello world</code>.
        </div>
      )}

      <NoteSections
        files={files}
        bindings={bindings}
        pushing={pushing}
        onPush={pushEntry}
        onArchive={archiveEntry}
        onRestore={restoreEntry}
        onPermaDelete={permaDeleteEntry}
      />
    </div>
  );
}

/** Splits notes three ways:
 *   - Active: not archived, binding NOT completed (or no binding)
 *   - Done: not archived, binding completed
 *   - Archived: archived (regardless of binding state)
 *
 * Done + Archived are collapsed by default so the Active list stays
 * focused. Archived entries can be Restored or permanently deleted. */
function NoteSections({
  files,
  bindings,
  pushing,
  onPush,
  onArchive,
  onRestore,
  onPermaDelete,
}: {
  files: NoteFile[];
  bindings: ReturnType<typeof useTaskBinding>;
  pushing: string | null;
  onPush: (key: string, body: string) => Promise<void> | void;
  onArchive: (date: string, entry: NoteEntry) => Promise<void> | void;
  onRestore: (date: string, entry: NoteEntry) => Promise<void> | void;
  onPermaDelete: (date: string, entry: NoteEntry) => Promise<void> | void;
}) {
  const [showDone, setShowDone] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const isDone = (key: string): boolean => {
    const b = bindings.get(key);
    return b?.status === 'completed';
  };

  const active: Array<{ file: NoteFile; entries: NoteEntry[] }> = [];
  const done: Array<{ file: NoteFile; entries: NoteEntry[] }> = [];
  const archived: Array<{ file: NoteFile; entries: NoteEntry[] }> = [];
  let doneCount = 0;
  let archivedCount = 0;
  for (const file of files) {
    const a: NoteEntry[] = [];
    const d: NoteEntry[] = [];
    const ar: NoteEntry[] = [];
    for (const entry of file.entries) {
      const key = `${file.date}-${entry.fileIndex}`;
      if (entry.archived) {
        ar.push(entry);
        archivedCount++;
      } else if (isDone(key)) {
        d.push(entry);
        doneCount++;
      } else {
        a.push(entry);
      }
    }
    if (a.length > 0) active.push({ file, entries: a });
    if (d.length > 0) done.push({ file, entries: d });
    if (ar.length > 0) archived.push({ file, entries: ar });
  }

  return (
    <>
      <div className="module-page__list">
        {active.map(({ file, entries }) => (
          <NoteFileCard
            key={`active-${file.date}`}
            file={file}
            entries={entries}
            bindings={bindings}
            pushing={pushing}
            onPush={onPush}
            onArchive={onArchive}
          />
        ))}
      </div>

      {/* Always render Done + Archived buckets so the user knows
          where future archives/done items will land — even when empty. */}
      <section className="note-done">
        <button
          className="note-done__head"
          onClick={() => setShowDone((v) => !v)}
          title={showDone ? 'Collapse done notes' : 'Expand done notes'}
        >
          <span className="note-done__caret">{showDone ? '▾' : '▸'}</span>
          <span className="note-done__label">Done</span>
          <span className="note-done__count">{doneCount}</span>
        </button>
        {showDone && (
          doneCount === 0 ? (
            <div className="note-done__empty">
              Notes you push to Claude land here once the task completes.
            </div>
          ) : (
            <div className="module-page__list note-done__list">
              {done.map(({ file, entries }) => (
                <NoteFileCard
                  key={`done-${file.date}`}
                  file={file}
                  entries={entries}
                  bindings={bindings}
                  pushing={pushing}
                  onPush={onPush}
                  onArchive={onArchive}
                  dimmed
                />
              ))}
            </div>
          )
        )}
      </section>

      <section className="note-done">
        <button
          className="note-done__head"
          onClick={() => setShowArchived((v) => !v)}
          title={showArchived ? 'Collapse archived' : 'Expand archived'}
        >
          <span className="note-done__caret">
            {showArchived ? '▾' : '▸'}
          </span>
          <span className="note-done__label">Archived</span>
          <span className="note-done__count note-done__count--archived">
            {archivedCount}
          </span>
        </button>
        {showArchived && (
          archivedCount === 0 ? (
            <div className="note-done__empty">
              Click × on an active note to archive it (soft-delete) —
              restore from here anytime.
            </div>
          ) : (
            <div className="module-page__list note-done__list">
              {archived.map(({ file, entries }) => (
                <ArchivedNoteFileCard
                  key={`archived-${file.date}`}
                  file={file}
                  entries={entries}
                  onRestore={onRestore}
                  onPermaDelete={onPermaDelete}
                />
              ))}
            </div>
          )
        )}
      </section>
    </>
  );
}

/** One day's worth of active/done note entries. The × button archives
 * (soft-delete); permanent removal lives in ArchivedNoteFileCard. */
function NoteFileCard({
  file,
  entries,
  bindings,
  pushing,
  onPush,
  onArchive,
  dimmed = false,
}: {
  file: NoteFile;
  entries: NoteEntry[];
  bindings: ReturnType<typeof useTaskBinding>;
  pushing: string | null;
  onPush: (key: string, body: string) => Promise<void> | void;
  onArchive: (date: string, entry: NoteEntry) => Promise<void> | void;
  dimmed?: boolean;
}) {
  return (
    <article className={`bracketed note-card${dimmed ? ' note-card--dimmed' : ''}`}>
      <header className="note-card__date">{dateLabel(file.date)}</header>
      <div className="note-card__entries">
        {entries.map((entry) => {
          const key = `${file.date}-${entry.fileIndex}`;
          const binding = bindings.get(key);
          return (
            <div key={key} className="note-card__entry">
              <div className="note-card__entry-head">
                <span className="note-card__entry-time">{entry.time}</span>
                {binding ? (
                  <TaskBindingBadge
                    binding={binding}
                    onOpen={() =>
                      void window.jarvis.showAnswerHud(binding.taskId)
                    }
                    onRunAgain={() => {
                      bindings.clear(key);
                      void onPush(key, entry.body);
                    }}
                    onForget={() => bindings.clear(key)}
                  />
                ) : (
                  <button
                    className="note-card__push"
                    disabled={pushing === key}
                    onClick={() => void onPush(key, entry.body)}
                  >
                    {pushing === key ? 'Pushing…' : '↪ Push to Claude'}
                  </button>
                )}
                <button
                  className="note-card__delete"
                  title="Archive this note (you can restore it from the Archived section)"
                  onClick={() => void onArchive(file.date, entry)}
                >
                  ×
                </button>
              </div>
              <pre className="note-card__entry-body">{entry.body}</pre>
            </div>
          );
        })}
      </div>
    </article>
  );
}

/**
 * Archived-only variant: Restore + permanent delete (no push action,
 * since archived notes shouldn't be re-pushed to Claude without restoring
 * first — otherwise the user loses track of why they archived it).
 */
function ArchivedNoteFileCard({
  file,
  entries,
  onRestore,
  onPermaDelete,
}: {
  file: NoteFile;
  entries: NoteEntry[];
  onRestore: (date: string, entry: NoteEntry) => Promise<void> | void;
  onPermaDelete: (date: string, entry: NoteEntry) => Promise<void> | void;
}) {
  return (
    <article className="bracketed note-card note-card--dimmed">
      <header className="note-card__date">{dateLabel(file.date)}</header>
      <div className="note-card__entries">
        {entries.map((entry) => (
          <div key={entry.fileIndex} className="note-card__entry">
            <div className="note-card__entry-head">
              <span className="note-card__entry-time">{entry.time}</span>
              {entry.archivedAt && (
                <span className="note-card__archived-meta">
                  archived {formatArchivedAt(entry.archivedAt)}
                </span>
              )}
              <button
                className="note-card__push"
                onClick={() => void onRestore(file.date, entry)}
                title="Move back to Active"
              >
                ↶ Restore
              </button>
              <button
                className="note-card__delete"
                title="Delete forever — can't be undone"
                onClick={() => void onPermaDelete(file.date, entry)}
              >
                ×
              </button>
            </div>
            <pre className="note-card__entry-body">{entry.body}</pre>
          </div>
        ))}
      </div>
    </article>
  );
}

function formatArchivedAt(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const m = Math.round(diff / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}
