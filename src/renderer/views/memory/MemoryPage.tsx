import { useEffect, useState } from 'react';

import { MemoryGraph } from './MemoryGraph';
import { KIND_STYLES } from './types';

/**
 * /memory route — the "what Jarvis knows" graph view.
 *
 * Chrome:
 *   - Kind filter chips (toggle which artifact types render)
 *   - Recency filter (last 7d / 30d / 90d / all)
 *   - Semantic overlay toggle + threshold slider
 *
 * Body: <MemoryGraph /> takes up the remaining space.
 */

type Recency = '7d' | '30d' | '90d' | 'all';

const RECENCY_MS: Record<Recency, number | null> = {
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  all: null,
};

const KIND_FILTER_KEY = 'jarvis.memory.kinds';
const RECENCY_KEY = 'jarvis.memory.recency';
const SEMANTIC_KEY = 'jarvis.memory.semantic';

function loadStored<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    if (v == null) return fallback;
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
function saveStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function MemoryPage() {
  const [counts, setCounts] = useState<Array<{ kind: string; count: number }>>(
    [],
  );
  const [activeKinds, setActiveKinds] = useState<Set<string>>(() => {
    const stored = loadStored<string[] | null>(KIND_FILTER_KEY, null);
    return stored ? new Set(stored) : new Set();
  });
  const [recency, setRecency] = useState<Recency>(() =>
    loadStored<Recency>(RECENCY_KEY, '90d'),
  );
  const [showSemantic, setShowSemantic] = useState<boolean>(() =>
    loadStored<boolean>(SEMANTIC_KEY, true),
  );
  const [semanticThreshold, setSemanticThreshold] = useState<number>(() =>
    loadStored<number>('jarvis.memory.threshold', 0.5),
  );

  useEffect(() => {
    void window.jarvis.artifactsCountByKind().then((c) => {
      setCounts(c);
      // Default: enable every kind that has artifacts. First load only —
      // the persisted set wins on subsequent loads.
      if (activeKinds.size === 0) {
        const next = new Set(c.map((row) => row.kind));
        setActiveKinds(next);
        saveStored(KIND_FILTER_KEY, Array.from(next));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleKind = (kind: string) => {
    const next = new Set(activeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setActiveKinds(next);
    saveStored(KIND_FILTER_KEY, Array.from(next));
  };

  const recencyMs = RECENCY_MS[recency];
  const since = recencyMs == null ? null : Date.now() - recencyMs;

  return (
    <section className="mem-page">
      <header className="mem-page__toolbar">
        <div className="mem-page__toolbar-section">
          <span className="mem-page__toolbar-label">KINDS</span>
          {counts.map(({ kind, count }) => {
            const style = KIND_STYLES[kind] ?? {
              label: kind,
              glyph: '◌',
              tint: 'rgb(160, 160, 180)',
            };
            const active = activeKinds.has(kind);
            return (
              <button
                key={kind}
                className={`mem-page__chip${active ? ' mem-page__chip--active' : ''}`}
                style={
                  {
                    '--mem-tint': style.tint,
                  } as React.CSSProperties
                }
                onClick={() => toggleKind(kind)}
                title={`${count} indexed`}
              >
                <span className="mem-page__chip-glyph">{style.glyph}</span>
                {style.label}
                <span className="mem-page__chip-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="mem-page__toolbar-section">
          <span className="mem-page__toolbar-label">RANGE</span>
          {(['7d', '30d', '90d', 'all'] as const).map((r) => (
            <button
              key={r}
              className={`mem-page__range${r === recency ? ' mem-page__range--active' : ''}`}
              onClick={() => {
                setRecency(r);
                saveStored(RECENCY_KEY, r);
              }}
            >
              {r === 'all' ? 'all time' : `last ${r}`}
            </button>
          ))}
        </div>
        <div className="mem-page__toolbar-section">
          <label className="mem-page__semantic">
            <input
              type="checkbox"
              checked={showSemantic}
              onChange={(e) => {
                setShowSemantic(e.target.checked);
                saveStored(SEMANTIC_KEY, e.target.checked);
              }}
            />
            <span>SEMANTIC NEIGHBOURS</span>
          </label>
          {showSemantic && (
            <label
              className="mem-page__threshold"
              title="Cosine similarity threshold"
            >
              <span>sim ≥</span>
              <input
                type="range"
                min={0.35}
                max={0.9}
                step={0.05}
                value={semanticThreshold}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setSemanticThreshold(v);
                  saveStored('jarvis.memory.threshold', v);
                }}
              />
              <span>{semanticThreshold.toFixed(2)}</span>
            </label>
          )}
        </div>
      </header>
      <main className="mem-page__canvas">
        <MemoryGraph
          showSemantic={showSemantic}
          semanticThreshold={semanticThreshold}
          kindFilter={activeKinds.size > 0 ? activeKinds : null}
          sinceMs={since}
        />
      </main>
    </section>
  );
}
