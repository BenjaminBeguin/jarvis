import { useEffect, useState } from 'react';

import { moduleIdFromActivityKind } from '@shared/activity-modules';
import type {
  ActivityEvent,
  ModuleSettingField,
  ModuleSettingValue,
  ModuleSettingsValues,
  ModuleSummary,
} from '../../shared/types';
import { toast } from './Toaster';

/**
 * Modal that surfaces both per-module settings AND a recent-activity
 * pane filtered to that module. Opens from a "⚙ Settings" affordance
 * on a module tile. Two reasons to be a modal rather than inline:
 *
 *   - Several modules will eventually have many settings; cramming
 *     them under the tile was already getting noisy with two fields.
 *   - The history pane needs vertical room and benefits from being
 *     centered + scrollable rather than pushing other tiles around.
 *
 * Settings writes go through the existing writeModuleSettings IPC;
 * activity is fetched on open and live-updated via onActivityChanged.
 */
export function ModuleSettingsModal({
  module: m,
  onClose,
}: {
  module: ModuleSummary;
  onClose: () => void;
}) {
  // ESC closes — standard modal expectation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="module-settings-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="module-settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="module-settings-modal__head">
          <div>
            <h2>{m.name}</h2>
            <span className="module-settings-modal__id">
              {m.id} · v{m.version}
            </span>
          </div>
          <button
            onClick={onClose}
            className="module-settings-modal__close"
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>
        <p className="module-settings-modal__desc">{m.description}</p>

        <SettingsPanel module={m} />

        <HistoryPane moduleId={m.id} />
      </div>
    </div>
  );
}

/**
 * Schema-driven settings — same as the inline panel that used to live
 * in ModulesPage. Moved here so the modal owns the surface; the page
 * tiles now just open this modal.
 */
function SettingsPanel({ module: m }: { module: ModuleSummary }) {
  const [values, setValues] = useState<ModuleSettingsValues>(
    m.settingsValues ?? {},
  );
  const [busy, setBusy] = useState(false);

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

  if (!m.settings || m.settings.fields.length === 0) {
    return (
      <section className="module-settings-modal__section">
        <h3>Settings</h3>
        <p className="module-settings-modal__empty">
          This module doesn&apos;t expose any settings yet.
        </p>
      </section>
    );
  }

  return (
    <section className="module-settings-modal__section">
      <h3>Settings</h3>
      {m.settings.description && (
        <p className="module-settings-modal__hint">
          {m.settings.description}
        </p>
      )}
      <div className="module-settings__fields">
        {m.settings.fields.map((field) => (
          <SettingsField
            key={field.key}
            field={field}
            value={values[field.key] ?? field.default}
            onChange={(v) => void update(field.key, v)}
          />
        ))}
      </div>
    </section>
  );
}

function SettingsField({
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

/**
 * Filtered history pane — shows the last ~80 activity events whose
 * kind attributes to this module via moduleIdFromActivityKind. Live
 * updates: subscribes to onActivityChanged so the latest fire / save
 * appears at the top without the user reopening the modal.
 */
function HistoryPane({ moduleId }: { moduleId: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.listActivity(500).then((list) => {
      if (cancelled) return;
      setEvents(
        list.filter(
          (e) => moduleIdFromActivityKind(e.kind, e.detail) === moduleId,
        ),
      );
      setLoading(false);
    });
    const off = window.jarvis.onActivityChanged((ev) => {
      if (moduleIdFromActivityKind(ev.kind, ev.detail) !== moduleId) return;
      // Prepend, then trim to 80 so the list doesn't grow unbounded.
      setEvents((prev) => [ev, ...prev].slice(0, 80));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [moduleId]);

  return (
    <section className="module-settings-modal__section">
      <div className="module-settings-modal__history-head">
        <h3>History</h3>
        <span className="module-settings-modal__history-count">
          {events.length === 0 ? '—' : `${events.length} events`}
        </span>
      </div>
      <p className="module-settings-modal__hint">
        Every side-effect this module emits, newest first. Same data as the
        Activity tab — filtered here so you can audit just this module.
      </p>
      {loading ? (
        <div className="module-settings-modal__loading">Loading…</div>
      ) : events.length === 0 ? (
        <div className="module-settings-modal__empty">
          Nothing yet. Activity events show up here as you use the module.
        </div>
      ) : (
        <ol className="module-settings-modal__events">
          {events.slice(0, 80).map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ol>
      )}
    </section>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="module-settings-modal__event">
      <span className="module-settings-modal__event-kind">{event.kind}</span>
      <span className="module-settings-modal__event-label">{event.label}</span>
      <time className="module-settings-modal__event-time">
        {formatRelative(event.ts)}
      </time>
    </li>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString();
}
