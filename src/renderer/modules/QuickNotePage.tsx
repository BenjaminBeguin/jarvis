import { useEffect, useState } from 'react';

import type { JarvisFileEntry } from '../../shared/types';

interface NoteFile {
  date: string; // YYYY-MM-DD from filename
  body: string;
  mtimeMs: number;
}

function dateLabel(iso: string): string {
  // 2026-05-13 → "Tue · May 13"
  const [y, m, d] = iso.split('-').map((v) => parseInt(v, 10));
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function QuickNotePage() {
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
          const body = await window.jarvis.readJarvisFile(`notes/${entry.name}`);
          return {
            date: entry.name.replace(/\.md$/, ''),
            body,
            mtimeMs: entry.mtimeMs,
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

  return (
    <div className="module-page">
      <header className="module-page__header">
        <div>
          <h2>NOTES</h2>
          <p>
            Type <code>/note &lt;text&gt;</code> in the palette · saved to
            {' '}<code>~/.jarvis/notes/</code>
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
            <pre className="note-card__body">{f.body.trim()}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}
