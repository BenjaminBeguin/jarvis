import { useEffect, useState } from 'react';

import { MarkdownText } from '../MarkdownText';
import { styleForKind, type ArtifactDetail } from './types';

interface Props {
  id: string;
  onClose: () => void;
  onOpen: (id: string) => void;
}

/**
 * Side panel that opens when the user clicks a node in the memory
 * graph. Shows the full artifact body + frontmatter + every link in
 * and out, so the user can drill into related nodes without leaving
 * the graph.
 */
export function MemoryDetailPanel({ id, onClose, onOpen }: Props) {
  const [data, setData] = useState<ArtifactDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.jarvis
      .artifactsRead(id)
      .then((res) => {
        if (cancelled) return;
        setData(res as ArtifactDetail | null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <aside
      className="mem-detail"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Artifact detail"
    >
      <header className="mem-detail__head">
        <span className="mem-detail__id">{id}</span>
        <button
          className="mem-detail__close"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
      </header>
      {loading && <div className="mem-detail__loading">LOADING…</div>}
      {!loading && !data && (
        <div className="mem-detail__loading">Artifact not found.</div>
      )}
      {!loading && data && (
        <div className="mem-detail__body">
          <DetailHeading data={data} />
          {data.frontmatter && Object.keys(data.frontmatter).length > 0 && (
            <Frontmatter data={data.frontmatter} />
          )}
          <Links data={data} onOpen={onOpen} />
          <section className="mem-detail__content">
            <h4 className="mem-detail__section-head">CONTENT</h4>
            <div className="mem-detail__content-body">
              <MarkdownText>{data.content || '_no content_'}</MarkdownText>
            </div>
          </section>
          {data.url && /^https?:\/\//i.test(data.url) && (
            <button
              className="mem-detail__open-external"
              onClick={() => void window.jarvis.openExternal(data.url!)}
            >
              ↗ Open external
            </button>
          )}
          {data.url && /^vscode:\/\//.test(data.url) && (
            <button
              className="mem-detail__open-external"
              onClick={() => void window.jarvis.openExternal(data.url!)}
            >
              ↗ Open in VS Code
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function DetailHeading({ data }: { data: ArtifactDetail }) {
  const style = styleForKind(data.kind);
  return (
    <div
      className="mem-detail__heading"
      style={{ '--mem-tint': style.tint } as React.CSSProperties}
    >
      <div className="mem-detail__glyph">{style.glyph}</div>
      <div className="mem-detail__heading-text">
        <div className="mem-detail__kind">{style.label}</div>
        <h3 className="mem-detail__title">{data.title}</h3>
        <div className="mem-detail__meta">
          {data.project && (
            <span className="mem-detail__project">{data.project}</span>
          )}
          <span>updated {formatAgo(data.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function Frontmatter({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return null;
  return (
    <section className="mem-detail__frontmatter">
      <h4 className="mem-detail__section-head">METADATA</h4>
      <dl>
        {entries.map(([k, v]) => (
          <div key={k} className="mem-detail__fm-row">
            <dt>{k}</dt>
            <dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Links({
  data,
  onOpen,
}: {
  data: ArtifactDetail;
  onOpen: (id: string) => void;
}) {
  const { linksIn, linksOut } = data;
  if (linksIn.length === 0 && linksOut.length === 0) return null;
  return (
    <section className="mem-detail__links">
      <h4 className="mem-detail__section-head">CONNECTIONS</h4>
      {linksOut.length > 0 && (
        <div className="mem-detail__links-block">
          <div className="mem-detail__links-label">OUTBOUND</div>
          <ul>
            {linksOut.map((l, i) => (
              <li key={`out-${i}`}>
                <button
                  className="mem-detail__link-target"
                  onClick={() => onOpen(l.to)}
                  title={`Open ${l.to}`}
                >
                  <span className="mem-detail__link-kind">{l.kind}</span>
                  <span className="mem-detail__link-id">→ {l.to}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {linksIn.length > 0 && (
        <div className="mem-detail__links-block">
          <div className="mem-detail__links-label">INBOUND</div>
          <ul>
            {linksIn.map((l, i) => (
              <li key={`in-${i}`}>
                <button
                  className="mem-detail__link-target"
                  onClick={() => onOpen(l.from)}
                  title={`Open ${l.from}`}
                >
                  <span className="mem-detail__link-kind">{l.kind}</span>
                  <span className="mem-detail__link-id">← {l.from}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function formatAgo(ts: number): string {
  const ms = Date.now() - ts;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
