import { useEffect, useState } from 'react';

import type { ModuleSummary } from '../../shared/types';
import { ModuleSettingsModal } from './ModuleSettingsModal';

interface Props {
  onOpenPage: (moduleId: string) => void;
}

/**
 * Single unified list of modules — no two-tier split between
 * page-modules and background-watchers. Every module gets the
 * same row shape: glyph + name + intents + settings + toggle.
 * Modules with a dedicated page surface an extra "Open →"
 * affordance at the right; everything else looks identical.
 */
export function ModulesPage({ onOpenPage }: Props) {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsForId, setSettingsForId] = useState<string | null>(null);

  useEffect(() => {
    void window.jarvis.listModules().then(setModules);
    const off = window.jarvis.onModulesChanged(setModules);
    return off;
  }, []);

  const toggle = async (m: ModuleSummary): Promise<void> => {
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

  // Pageable modules first (they're the daily-driver ones), then
  // background watchers. Same row shape; sort just controls vertical
  // priority without splitting the list visually.
  const sorted = [...modules].sort((a, b) => {
    if (a.hasPage !== b.hasPage) return a.hasPage ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <section className="modules-page">
      <header className="modules-page__header">
        <div>
          <h2>MODULES</h2>
          <p>
            Self-contained features. Toggle each one on/off, open the
            page where there is one, or click the gear for settings +
            history.
          </p>
        </div>
      </header>

      {error && <div className="modules-page__error">{error}</div>}

      <div className="modules-page__list">
        {sorted.map((m) => (
          <ModuleRow
            key={m.id}
            module={m}
            busy={busy === m.id}
            onToggle={() => void toggle(m)}
            onOpen={m.hasPage ? () => onOpenPage(m.id) : null}
            onOpenSettings={() => setSettingsForId(m.id)}
          />
        ))}
      </div>

      {settingsModule && (
        <ModuleSettingsModal
          module={settingsModule}
          onClose={() => setSettingsForId(null)}
        />
      )}
    </section>
  );
}

interface ModuleRowProps {
  module: ModuleSummary;
  busy: boolean;
  /** Null when the module has no page (background watcher). */
  onOpen: (() => void) | null;
  onToggle: () => void;
  onOpenSettings: () => void;
}

function ModuleRow({
  module: m,
  busy,
  onOpen,
  onToggle,
  onOpenSettings,
}: ModuleRowProps) {
  const glyph = MODULE_GLYPHS[m.id] ?? '◇';
  const clickable = !!onOpen && m.enabled;
  return (
    <article
      className={`module-row${m.enabled ? '' : ' module-row--off'}${clickable ? ' module-row--clickable' : ''}`}
      onClick={clickable ? onOpen : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen!();
              }
            }
          : undefined
      }
    >
      <span className="module-row__glyph">{glyph}</span>
      <div className="module-row__main">
        <div className="module-row__head">
          <span className="module-row__name">{m.name}</span>
          <span className="module-row__id">
            {m.id} · v{m.version}
          </span>
        </div>
        <div className="module-row__desc">{m.description}</div>
        {m.intents.length > 0 && (
          <div className="module-row__intents">
            {m.intents.map((i) => (
              <span key={i.id} className="intent-chip intent-chip--inline">
                <span className="intent-chip__prefix">{i.prefix}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="module-row__actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="module-row__settings"
          onClick={onOpenSettings}
          title="Settings + history"
          aria-label="Settings + history"
        >
          ⚙
        </button>
        <label className="toggle" title={m.enabled ? 'Disable' : 'Enable'}>
          <input
            type="checkbox"
            checked={m.enabled}
            disabled={busy}
            onChange={onToggle}
          />
          {m.enabled ? 'on' : 'off'}
        </label>
        {onOpen && (
          <span
            className="module-row__cta"
            aria-hidden
            title={m.enabled ? 'Open module page' : 'Enable to open'}
          >
            Open →
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * Per-module glyph. Falls back to ◇ for any new module we haven't
 * picked one for.
 */
const MODULE_GLYPHS: Record<string, string> = {
  'quick-note': '✎',
  'meeting-recorder': '🎙',
  send: '↗',
  'pr-workflows': '⎇',
  status: '⊙',
  'skill-suggester': '✦',
  shell: '⌘',
  'shell-nav': '◈',
  'claude-code-watch': '◉',
  reminders: '⏰',
  calendar: '📅',
  workflows: '⚡',
  'telegram-bot': '✈',
};
