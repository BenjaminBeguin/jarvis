import { useEffect, useMemo, useState } from 'react';

import type { JarvisFileEntry } from '../../shared/types';
import { MarkdownText } from '../views/MarkdownText';
import { formatRelative } from '../views/TaskList';

interface MeetingFile {
  name: string;
  body: string;
  mtimeMs: number;
  title: string;
  durationSec: number | null;
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) meta[k] = v;
  }
  return { meta, body: match[2] ?? '' };
}

const PUSH_PROMPT_PREFIX =
  'I just finished this meeting. Help me act on it — pull out concrete action items with owners and deadlines where stated, flag anything unclear, and suggest follow-ups I should write today.\n\n---\n\n';

export function MeetingsPage() {
  const [files, setFiles] = useState<MeetingFile[]>([]);
  const [openName, setOpenName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const entries: JarvisFileEntry[] = await window.jarvis.listJarvisDir(
        'meetings',
      );
      const mdFiles = entries
        .filter((e) => !e.isDir && e.name.endsWith('.md'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const loaded = await Promise.all(
        mdFiles.map(async (entry) => {
          const raw = await window.jarvis.readJarvisFile(`meetings/${entry.name}`);
          const { meta, body } = parseFrontmatter(raw);
          return {
            name: entry.name,
            body,
            mtimeMs: entry.mtimeMs,
            title: meta['title'] || entry.name.replace(/\.md$/, ''),
            durationSec: meta['duration_seconds']
              ? parseInt(meta['duration_seconds'], 10)
              : null,
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

  const opened = useMemo(
    () => files.find((f) => f.name === openName) ?? null,
    [files, openName],
  );

  const pushToClaude = async (file: MeetingFile) => {
    setPushing(file.name);
    try {
      await window.jarvis.launchTask({
        prompt: `${PUSH_PROMPT_PREFIX}${file.body}`,
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
          <h2>MEETINGS</h2>
          <p>
            Type <code>/meeting [title]</code> in the palette to record · stored under{' '}
            <code>~/.jarvis/meetings/</code>
          </p>
        </div>
        <button onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </header>

      {error && <div className="module-page__error">{error}</div>}

      {!loading && files.length === 0 && (
        <div className="module-page__empty">
          No meetings yet. Hit ⌘⇧J and try <code>/meeting standup</code>.
        </div>
      )}

      <div className="module-page__list">
        {files.map((f) => {
          const isOpen = f.name === opened?.name;
          return (
            <article key={f.name} className="bracketed meeting-card">
              <header className="meeting-card__head">
                <div className="meeting-card__title">{f.title}</div>
                <div className="meeting-card__meta">
                  {formatRelative(f.mtimeMs)}
                  {f.durationSec != null && (
                    <> · {Math.floor(f.durationSec / 60)}m {f.durationSec % 60}s</>
                  )}
                </div>
              </header>
              <div className="meeting-card__actions">
                <button
                  onClick={() => setOpenName(isOpen ? null : f.name)}
                >
                  {isOpen ? 'Collapse' : 'View'}
                </button>
                <button
                  onClick={() => void pushToClaude(f)}
                  disabled={pushing === f.name}
                >
                  {pushing === f.name ? 'Pushing…' : '↪ Push to Claude'}
                </button>
              </div>
              {isOpen && (
                <div className="meeting-card__body">
                  <MarkdownText>{f.body}</MarkdownText>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
