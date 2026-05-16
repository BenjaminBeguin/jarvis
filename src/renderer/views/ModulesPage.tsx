import { useEffect, useMemo, useState } from 'react';

import type {
  ModuleSettingField,
  ModuleSettingValue,
  ModuleSettingsValues,
  ModuleSummary,
} from '../../shared/types';
import { toast } from './Toaster';

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
            <div key={m.id} className="modules-page__page-wrap">
              <ModulePageTile
                module={m}
                busy={busy === m.id}
                onOpen={() => onOpenPage(m.id)}
                onToggle={() => void toggle(m)}
              />
              {m.settings && m.enabled && (
                <ModuleSettingsPanel module={m} />
              )}
            </div>
          ))}
        </div>
      )}

      {background.length > 0 && (
        <>
          <h3 className="modules-page__section-title">Background watchers</h3>
          <div className="modules-page__bg-list">
            {background.map((m) => (
              <div key={m.id} className="modules-page__bg-wrap">
                <ModuleBackgroundRow
                  module={m}
                  busy={busy === m.id}
                  onToggle={() => void toggle(m)}
                />
                {m.settings && m.enabled && (
                  <ModuleSettingsPanel module={m} />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

interface ModuleTileProps {
  module: ModuleSummary;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
}

function ModulePageTile({ module: m, busy, onOpen, onToggle }: ModuleTileProps) {
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

      <div className="module-tile__cta">
        Open <span aria-hidden>→</span>
      </div>
    </article>
  );
}

interface ModuleBgProps {
  module: ModuleSummary;
  busy: boolean;
  onToggle: () => void;
}

function ModuleBackgroundRow({ module: m, busy, onToggle }: ModuleBgProps) {
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

/**
 * Schema-driven settings panel rendered below a module tile/row when
 * the module declares `settings.fields`. Each field gets an input
 * matched to its type; writes go through writeModuleSettings IPC.
 * Optimistic UI — the input value follows local state, and the IPC
 * round-trip is fire-and-forget (errors surface as toasts).
 *
 * Keep this component generic — modules describe their schema, the
 * renderer doesn't special-case any of them.
 */
function ModuleSettingsPanel({ module: m }: { module: ModuleSummary }) {
  const [values, setValues] = useState<ModuleSettingsValues>(
    m.settingsValues ?? {},
  );
  const [busy, setBusy] = useState(false);

  // Reconcile when the parent re-fetches the module list (e.g. after
  // someone else writes to the same module's settings). We only adopt
  // the upstream values when not actively saving to avoid clobbering
  // the user's in-flight edit.
  useEffect(() => {
    if (!busy && m.settingsValues) setValues(m.settingsValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.settingsValues]);

  const update = async (key: string, value: ModuleSettingValue) => {
    const next = { ...values, [key]: value };
    setValues(next);
    setBusy(true);
    try {
      const r = await window.jarvis.writeModuleSettings(m.id, next);
      if (!r.ok) {
        toast({ kind: 'error', message: r.message ?? 'Save failed' });
      }
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  if (!m.settings || m.settings.fields.length === 0) return null;

  return (
    <div className="module-settings">
      <div className="module-settings__head">
        <span className="module-settings__label">Settings</span>
        {m.settings.description && (
          <span className="module-settings__desc">
            {m.settings.description}
          </span>
        )}
      </div>
      <div className="module-settings__fields">
        {m.settings.fields.map((field) => (
          <ModuleSettingsField
            key={field.key}
            field={field}
            value={values[field.key] ?? field.default}
            onChange={(v) => void update(field.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

function ModuleSettingsField({
  field,
  value,
  onChange,
}: {
  field: ModuleSettingField;
  value: ModuleSettingValue;
  onChange: (next: ModuleSettingValue) => void;
}) {
  return (
    <label className="module-settings__field">
      <span className="module-settings__field-label">{field.label}</span>
      {field.hint && (
        <span className="module-settings__field-hint">{field.hint}</span>
      )}
      <div className="module-settings__field-input">
        {field.type === 'boolean' && (
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
          />
        )}
        {field.type === 'number' && (
          <>
            <input
              type="number"
              value={typeof value === 'number' ? value : Number(value) || 0}
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              onChange={(e) => {
                const n = parseFloat(e.target.value);
                if (Number.isFinite(n)) onChange(n);
              }}
            />
            {field.unit && (
              <span className="module-settings__field-unit">{field.unit}</span>
            )}
          </>
        )}
        {field.type === 'text' && (
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {field.type === 'select' && (
          <select
            value={String(value)}
            onChange={(e) => {
              const raw = e.target.value;
              const opt = field.options?.find((o) => String(o.value) === raw);
              onChange(opt ? opt.value : raw);
            }}
          >
            {field.options?.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </label>
  );
}
