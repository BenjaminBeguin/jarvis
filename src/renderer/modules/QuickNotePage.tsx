import { useEffect, useState } from 'react';

import type { JarvisFileEntry } from '../../shared/types';

interface NoteEntry {
  time: string;
  body: string;
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
  // original markdown.
  const entries: NoteEntry[] = [];
  const re = /(?:^|\n)## (\d{2}:\d{2})\n([\s\S]*?)(?=\n## \d{2}:\d{2}|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const time = m[1];
    const body = m[2].trim();
    if (body) entries.push({ time, body });
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
      await window.jarvis.launchTask({
        prompt: `${PUSH_PROMPT_PREFIX}${body}`,
        origin: 'palette',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(null);
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

      <div className="module-page__list">
        {files.map((f) => (
          <article key={f.date} className="bracketed note-card">
            <header className="note-card__date">{dateLabel(f.date)}</header>
            <div className="note-card__entries">
              {f.entries.map((entry, i) => {
                const key = `${f.date}-${i}`;
                return (
                  <div key={key} className="note-card__entry">
                    <div className="note-card__entry-head">
                      <span className="note-card__entry-time">{entry.time}</span>
                      <button
                        className="note-card__push"
                        disabled={pushing === key}
                        onClick={() => void pushEntry(key, entry.body)}
                      >
                        {pushing === key ? 'Pushing…' : '↪ Push to Claude'}
                      </button>
                    </div>
                    <pre className="note-card__entry-body">{entry.body}</pre>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
