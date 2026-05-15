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
}

interface NoteFile {
  date: string;
  mtimeMs: number;
  entries: NoteEntry[];
  raw: string;
}

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
    const body = m[2].trim();
    if (body) entries.push({ time, body, fileIndex: i });
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

export function QuickNotePage() {
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

  const deleteEntry = async (date: string, entry: NoteEntry) => {
    const preview =
      entry.body.length > 60 ? `${entry.body.slice(0, 60)}…` : entry.body;
    if (!confirm(`Delete note from ${date} ${entry.time}?\n\n"${preview}"`)) return;
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
    <div className="module-page">
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
        onDelete={deleteEntry}
      />
    </div>
  );
}

/** Splits notes by binding status — entries whose bound task has
 * status === 'completed' are moved into a collapsed "Done" section so
 * the Active list stays focused on what still needs attention. The
 * Done section keeps the badge so the user can still open the
 * Claude session that handled it. */
function NoteSections({
  files,
  bindings,
  pushing,
  onPush,
  onDelete,
}: {
  files: NoteFile[];
  bindings: ReturnType<typeof useTaskBinding>;
  pushing: string | null;
  onPush: (key: string, body: string) => Promise<void> | void;
  onDelete: (date: string, entry: NoteEntry) => Promise<void> | void;
}) {
  const [showDone, setShowDone] = useState(false);

  const isDone = (key: string): boolean => {
    const b = bindings.get(key);
    return b?.status === 'completed';
  };

  const active: Array<{ file: NoteFile; entries: NoteEntry[] }> = [];
  const done: Array<{ file: NoteFile; entries: NoteEntry[] }> = [];
  let doneCount = 0;
  for (const file of files) {
    const a: NoteEntry[] = [];
    const d: NoteEntry[] = [];
    for (let i = 0; i < file.entries.length; i++) {
      const entry = file.entries[i]!;
      const key = `${file.date}-${i}`;
      if (isDone(key)) {
        d.push(entry);
        doneCount++;
      } else {
        a.push(entry);
      }
    }
    if (a.length > 0) active.push({ file, entries: a });
    if (d.length > 0) done.push({ file, entries: d });
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
            onDelete={onDelete}
          />
        ))}
      </div>

      {doneCount > 0 && (
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
            <div className="module-page__list note-done__list">
              {done.map(({ file, entries }) => (
                <NoteFileCard
                  key={`done-${file.date}`}
                  file={file}
                  entries={entries}
                  bindings={bindings}
                  pushing={pushing}
                  onPush={onPush}
                  onDelete={onDelete}
                  dimmed
                />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** One day's worth of note entries, filtered by the parent. Lives as
 * its own component so the Active + Done sections can each reuse the
 * date-card markup without duplicating the per-entry render. */
function NoteFileCard({
  file,
  entries,
  bindings,
  pushing,
  onPush,
  onDelete,
  dimmed = false,
}: {
  file: NoteFile;
  entries: NoteEntry[];
  bindings: ReturnType<typeof useTaskBinding>;
  pushing: string | null;
  onPush: (key: string, body: string) => Promise<void> | void;
  onDelete: (date: string, entry: NoteEntry) => Promise<void> | void;
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
                  title="Delete this note"
                  onClick={() => void onDelete(file.date, entry)}
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
