import { useEffect, useState } from 'react';

import type { ModuleSummary } from '../../shared/types';

interface Props {
  onOpenPage: (moduleId: string) => void;
}

export function ModulesPage({ onOpenPage }: Props) {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.jarvis.listModules().then(setModules);
    const off = window.jarvis.onModulesChanged(setModules);
    return off;
  }, []);

  const toggle = async (m: ModuleSummary) => {
    setBusy(m.id);
    setError(null);
    try {
      await window.jarvis.setModuleEnabled(m.id, !m.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="modules-page">
      <header className="modules-page__header">
        <div>
          <h2>MODULES</h2>
          <p>
            Self-contained features. Drop a new one under{' '}
            <code>electron/main/modules/</code> and it shows up here.
          </p>
        </div>
      </header>

      {error && <div className="modules-page__error">{error}</div>}

      <div className="modules-page__grid">
        {modules.map((m) => (
          <article
            key={m.id}
            className={`bracketed module-card${m.enabled ? '' : ' module-card--off'}`}
          >
            <header className="module-card__head">
              <div className="module-card__name">{m.name}</div>
              <label className="toggle" title={m.enabled ? 'Disable' : 'Enable'}>
                <input
                  type="checkbox"
                  checked={m.enabled}
                  disabled={busy === m.id}
                  onChange={() => void toggle(m)}
                />
                {m.enabled ? 'on' : 'off'}
              </label>
            </header>
            <div className="module-card__id">{m.id} · v{m.version}</div>
            <div className="module-card__desc">{m.description}</div>

            {m.intents.length > 0 && (
              <div className="module-card__intents">
                <div className="module-card__section-label">Palette</div>
                <div className="module-card__intent-list">
                  {m.intents.map((i) => (
                    <span key={i.id} className="intent-chip">
                      <span className="intent-chip__prefix">{i.prefix}</span>
                      <span className="intent-chip__label">{i.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {m.intents.length === 0 && m.enabled && (
              <div className="module-card__intents module-card__intents--none">
                No palette intents · runs as a background watcher
              </div>
            )}

            {m.hasPage && (
              <div className="module-card__actions">
                <button onClick={() => onOpenPage(m.id)} disabled={!m.enabled}>
                  Open page →
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
