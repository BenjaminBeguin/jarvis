import { useEffect, useMemo, useState } from 'react';

import { MarkdownText } from './MarkdownText';
import { toast } from './Toaster';

interface DigestKind {
  id: string;
  label: string;
  description: string;
  skillId: string;
  schedule?: string;
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

  useEffect(() => {
    void window.jarvis.listBriefingKinds().then((list) => {
      setKinds(list);
      if (list.length > 0) {
        setActiveKind((cur) => cur ?? list[0]!.id);
      }
    });
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
          Generated digests with citations. Pulled from meetings, PRs,
          Linear, notes. Each kind is a skill + a routine.
        </p>
        {kinds.map((k) => (
          <button
            key={k.id}
            className={`briefings__kind${k.id === activeKind ? ' briefings__kind--active' : ''}`}
            onClick={() => setActiveKind(k.id)}
          >
            <div className="briefings__kind-label">{k.label}</div>
            <div className="briefings__kind-desc">{k.description}</div>
            {k.schedule && (
              <div className="briefings__kind-schedule">
                suggested cron: <code>{k.schedule}</code>
              </div>
            )}
          </button>
        ))}
      </aside>

      <main className="briefings__main">
        {!activeKind && (
          <div className="briefings__placeholder">Pick a kind on the left.</div>
        )}
        {activeKind && (
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

            <div className="briefings__panes">
              <aside className="briefings__files">
                {files.length === 0 && (
                  <div className="briefings__empty">
                    Nothing generated yet. Hit "Generate now" to produce
                    the first one, or wire a routine on the suggested
                    cron.
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

              <article className="briefings__content">
                {content ? (
                  <MarkdownText>{content}</MarkdownText>
                ) : activeFile ? (
                  <div className="briefings__empty">Loading…</div>
                ) : (
                  <div className="briefings__empty">
                    Pick a file on the left.
                  </div>
                )}
              </article>
            </div>
          </>
        )}
      </main>
    </section>
  );
}
