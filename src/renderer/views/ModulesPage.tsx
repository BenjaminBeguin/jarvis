import { useEffect, useMemo, useState } from 'react';

import type { ModuleSummary } from '../../shared/types';
import { ModuleSettingsModal } from './ModuleSettingsModal';

interface Props {
  onOpenPage: (moduleId: string) => void;
}

/**
 * Two-tier layout: modules with their own page get large, fully-clickable
 * tiles at the top (the primary surface — these are where the user actually
 * lives day to day). Background watchers / modules without pages drop into
 * a compact strip below — toggles + intent chips, no oversized affordance.
 */
export function ModulesPage({ onOpenPage }: Props) {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** When non-null, the settings modal is open for this module. */
  const [settingsForId, setSettingsForId] = useState<string | null>(null);

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

  const settingsModule = settingsForId
    ? modules.find((m) => m.id === settingsForId)
    : null;

  const withPages = useMemo(
    () => modules.filter((m) => m.hasPage),
    [modules],
  );
  const background = useMemo(
    () => modules.filter((m) => !m.hasPage),
    [modules],
  );

  return (
    <section className="modules-page">
      <header className="modules-page__header">
        <div>
          <h2>MODULES</h2>
          <p>
            Self-contained features. Cards with a screen are at the top —
            click to open. Background watchers are below.
          </p>
        </div>
      </header>

      {error && <div className="modules-page__error">{error}</div>}

      {withPages.length > 0 && (
        <div className="modules-page__pages">
          {withPages.map((m) => (
            <ModulePageTile
              key={m.id}
              module={m}
              busy={busy === m.id}
              onOpen={() => onOpenPage(m.id)}
              onToggle={() => void toggle(m)}
              onOpenSettings={() => setSettingsForId(m.id)}
            />
          ))}
        </div>
      )}

      {background.length > 0 && (
        <>
          <h3 className="modules-page__section-title">Background watchers</h3>
          <div className="modules-page__bg-list">
            {background.map((m) => (
              <ModuleBackgroundRow
                key={m.id}
                module={m}
                busy={busy === m.id}
                onToggle={() => void toggle(m)}
                onOpenSettings={() => setSettingsForId(m.id)}
              />
            ))}
          </div>
        </>
      )}

      {settingsModule && (
        <ModuleSettingsModal
          module={settingsModule}
          onClose={() => setSettingsForId(null)}
        />
      )}
    </section>
  );
}

interface ModuleTileProps {
  module: ModuleSummary;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onOpenSettings: () => void;
}

function ModulePageTile({
  module: m,
  busy,
  onOpen,
  onToggle,
  onOpenSettings,
}: ModuleTileProps) {
  const glyph = MODULE_GLYPHS[m.id] ?? '◇';
  return (
    <article
      className={`module-tile${m.enabled ? '' : ' module-tile--off'}`}
      onClick={() => m.enabled && onOpen()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (m.enabled) onOpen();
        }
      }}
    >
      <div className="module-tile__glyph">{glyph}</div>
      <header className="module-tile__head">
        <div>
          <div className="module-tile__name">{m.name}</div>
          <div className="module-tile__id">{m.id} · v{m.version}</div>
        </div>
        <label
          className="toggle"
          title={m.enabled ? 'Disable' : 'Enable'}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={m.enabled}
            disabled={busy}
            onChange={onToggle}
          />
          {m.enabled ? 'on' : 'off'}
        </label>
      </header>
      <p className="module-tile__desc">{m.description}</p>

      {m.intents.length > 0 && (
        <div className="module-tile__intents">
          {m.intents.slice(0, 4).map((i) => (
            <span key={i.id} className="intent-chip">
              <span className="intent-chip__prefix">{i.prefix}</span>
            </span>
          ))}
          {m.intents.length > 4 && (
            <span className="intent-chip intent-chip--more">
              +{m.intents.length - 4}
            </span>
          )}
        </div>
      )}

      <div className="module-tile__footer">
        <button
          className="module-tile__settings"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings();
          }}
          title="Settings + history"
          aria-label="Settings + history"
        >
          ⚙ Settings
        </button>
        <span className="module-tile__cta">
          Open <span aria-hidden>→</span>
        </span>
      </div>
    </article>
  );
}

interface ModuleBgProps {
  module: ModuleSummary;
  busy: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
}

function ModuleBackgroundRow({
  module: m,
  busy,
  onToggle,
  onOpenSettings,
}: ModuleBgProps) {
  const glyph = MODULE_GLYPHS[m.id] ?? '◇';
  return (
    <article
      className={`module-bg-row${m.enabled ? '' : ' module-bg-row--off'}`}
    >
      <span className="module-bg-row__glyph">{glyph}</span>
      <div className="module-bg-row__main">
        <div className="module-bg-row__name">
          {m.name}{' '}
          <span className="module-bg-row__id">
            {m.id} · v{m.version}
          </span>
        </div>
        <div className="module-bg-row__desc">{m.description}</div>
        {m.intents.length > 0 && (
          <div className="module-bg-row__intents">
            {m.intents.map((i) => (
              <span key={i.id} className="intent-chip intent-chip--inline">
                <span className="intent-chip__prefix">{i.prefix}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="module-bg-row__actions">
        <button
          className="module-bg-row__settings"
          onClick={onOpenSettings}
          title="Settings + history"
          aria-label="Settings + history"
        >
          ⚙
        </button>
        <label
          className="toggle"
          title={m.enabled ? 'Disable' : 'Enable'}
        >
          <input
            type="checkbox"
            checked={m.enabled}
            disabled={busy}
            onChange={onToggle}
          />
          {m.enabled ? 'on' : 'off'}
        </label>
      </div>
    </article>
  );
}

/**
 * Per-module glyph for the tile. Keeps the visual quick to scan without
 * resorting to images (which would need to be theme-aware). Falls back to
 * a generic ◇ for any new module we haven't picked one for.
 */
const MODULE_GLYPHS: Record<string, string> = {
  'quick-note': '✎',
  'meeting-recorder': '🎙',
  send: '↗',
  'pr-workflows': '⎇',
  status: '⊙',
  'skill-suggester': '✦',
  'shell': '⌘',
  'shell-nav': '◈',
  'claude-code-watch': '◉',
  reminders: '⏰',
};

