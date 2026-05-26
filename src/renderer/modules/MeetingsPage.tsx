import { useEffect, useMemo, useState } from 'react';

import type { JarvisFileEntry } from '../../shared/types';
import { MarkdownText } from '../views/MarkdownText';
import { TaskBindingBadge } from '../views/TaskBindingBadge';
import { formatRelative } from '../views/TaskList';
import { useTaskBinding } from '../views/useTaskBinding';

interface MeetingFile {
  name: string;
  body: string;
  mtimeMs: number;
  title: string;
  durationSec: number | null;
  /** First non-blank line of the transcript, ~120 chars. Used as the
   *  row's collapsed preview so the user can recall what a meeting
   *  was without expanding. */
  preview: string | null;
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

function firstLinePreview(body: string, max = 140): string | null {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // Strip markdown heading / list markers so the preview reads as prose.
    const cleaned = t.replace(/^#+\s*|^[-*]\s*|^>\s*/, '').trim();
    if (!cleaned) continue;
    return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  }
  return null;
}

const PUSH_PROMPT_PREFIX =
  'I just finished this meeting. Help me act on it — pull out concrete action items with owners and deadlines where stated, flag anything unclear, and suggest follow-ups I should write today.\n\n---\n\n';

/**
 * Meetings index. Visually matches Routines / Workflows pages —
 * `wf-toolbar` on top, `wf-list` rows below — so the three "list of
 * agent-touched things" pages read as a family. Inline expand instead
 * of a detail route because meetings are READ surfaces (you skim,
 * push to Claude, move on); a separate page for each would add
 * navigation noise without unlocking new actions.
 */
export function MeetingsPage() {
  const [files, setFiles] = useState<MeetingFile[]>([]);
  const [openName, setOpenName] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState<string | null>(null);
  const bindings = useTaskBinding('meetings');

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
            preview: firstLinePreview(body),
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) =>
      `${f.title} ${f.body}`.toLowerCase().includes(q),
    );
  }, [files, search]);

  const pushToClaude = async (file: MeetingFile) => {
    setPushing(file.name);
    try {
      const summary = await window.jarvis.launchTask({
        prompt: `${PUSH_PROMPT_PREFIX}${file.body}`,
        origin: 'palette',
      });
      bindings.bind(file.name, summary.id);
      void window.jarvis.showAnswerHud(summary.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(null);
    }
  };

  const deleteFile = async (file: MeetingFile) => {
    const ok = window.confirm(
      `Delete "${file.title}"?\n\nThis removes ~/.jarvis/meetings/${file.name} permanently.`,
    );
    if (!ok) return;
    try {
      const result = await window.jarvis.deleteJarvisFile(
        `meetings/${file.name}`,
      );
      if (!result.ok) {
        setError(result.message ?? 'Delete failed.');
        return;
      }
      bindings.clear(file.name);
      if (openName === file.name) setOpenName(null);
      setFiles((cur) => cur.filter((f) => f.name !== file.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="rt-page mt-page">
      <header className="wf-toolbar">
        <span className="wf-toolbar__title">Meetings</span>
        <span className="mt-toolbar__hint">
          <code>/meeting [title]</code> in the palette · stored at{' '}
          <code>~/.jarvis/meetings/</code> · ↪ extracts action items via Claude
        </span>
        <div className="wf-toolbar__spacer" />
        {files.length > 0 && (
          <div className="rt-toolbar__search">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter meetings…"
              aria-label="Filter meetings"
            />
            {search && (
              <button
                type="button"
                className="rt-toolbar__search-clear"
                onClick={() => setSearch('')}
                title="Clear filter"
                aria-label="Clear filter"
              >
                ×
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className="wf-btn wf-btn--ghost"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? '…' : 'Refresh'}
        </button>
      </header>

      <div className="rt-body">
        {error && <div className="mt-error">{error}</div>}

        {!loading && files.length === 0 && (
          <div className="wf-list wf-list--empty">
            No meetings yet. Hit ⌘⇧J and try <code>/meeting standup</code>.
          </div>
        )}

        {!loading && files.length > 0 && filtered.length === 0 && (
          <div className="wf-list wf-list--empty">
            No meetings match "{search}".
          </div>
        )}

        {filtered.length > 0 && (
          <div className="wf-list">
            <div className="wf-list__group">
              {filtered.map((f) => (
                <MeetingRow
                  key={f.name}
                  file={f}
                  isOpen={f.name === openName}
                  isPushing={pushing === f.name}
                  binding={bindings.get(f.name)}
                  onToggle={() =>
                    setOpenName((cur) => (cur === f.name ? null : f.name))
                  }
                  onPush={() => void pushToClaude(f)}
                  onUnbind={() => bindings.clear(f.name)}
                  onDelete={() => void deleteFile(f)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function MeetingRow({
  file: f,
  isOpen,
  isPushing,
  binding,
  onToggle,
  onPush,
  onUnbind,
  onDelete,
}: {
  file: MeetingFile;
  isOpen: boolean;
  isPushing: boolean;
  binding: ReturnType<ReturnType<typeof useTaskBinding>['get']>;
  onToggle: () => void;
  onPush: () => void;
  onUnbind: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`mt-row${isOpen ? ' mt-row--open' : ''}`}>
      <article
        className="wf-list__row"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span
          className={`wf-list__dot${binding ? ' wf-list__dot--on' : ''}`}
          aria-hidden
          title={binding ? 'Pushed to Claude' : 'Not yet pushed'}
        />
        <div className="wf-list__main">
          <div className="wf-list__head">
            <span className="wf-list__name">{f.title}</span>
            <span className="wf-list__meta">
              {formatRelative(f.mtimeMs)}
              {f.durationSec != null && (
                <>
                  {' · '}
                  {Math.floor(f.durationSec / 60)}m {f.durationSec % 60}s
                </>
              )}
            </span>
          </div>
          {!isOpen && f.preview && (
            <div className="wf-list__desc">{f.preview}</div>
          )}
        </div>
        <div
          className="wf-list__actions"
          onClick={(e) => e.stopPropagation()}
        >
          {binding ? (
            <TaskBindingBadge
              binding={binding}
              onOpen={() => void window.jarvis.showAnswerHud(binding.taskId)}
              onRunAgain={() => {
                onUnbind();
                onPush();
              }}
              onForget={onUnbind}
            />
          ) : (
            <button
              type="button"
              className="wf-btn wf-btn--primary"
              onClick={(e) => {
                e.stopPropagation();
                onPush();
              }}
              disabled={isPushing}
              title="Send this transcript to a fresh Claude task. Pops the Answer HUD with extracted action items, owners, deadlines, and follow-ups."
            >
              {isPushing ? 'Pushing…' : '↪ Extract action items'}
            </button>
          )}
          <button
            type="button"
            className="wf-btn wf-btn--ghost mt-row__delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title={`Delete ~/.jarvis/meetings/${f.name}`}
            aria-label="Delete meeting"
          >
            🗑
          </button>
          <span
            className="wf-list__chev mt-row__chev"
            aria-hidden
            data-open={isOpen ? 'true' : undefined}
          >
            →
          </span>
        </div>
      </article>
      {isOpen && (
        <div className="mt-row__body">
          <MarkdownText>{f.body}</MarkdownText>
        </div>
      )}
    </div>
  );
}
