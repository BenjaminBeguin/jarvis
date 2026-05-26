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
        <div className="module-settings-modal__body">
          <p className="module-settings-modal__desc">{m.description}</p>

          <SettingsPanel module={m} />

          <MemoryPanel module={m} />

          <HistoryPane moduleId={m.id} />
        </div>
      </div>
    </div>
  );
}

/**
 * "Where this lives" — declarative storage footprint the module
 * advertised via `Module.memory`. Renders a compact table the user
 * can scan to answer "what does this module remember about me?"
 * without grepping. Modules without any declared storage skip the
 * section entirely (vs showing an empty state — silence is the
 * honest signal there).
 */
function MemoryPanel({ module: m }: { module: ModuleSummary }) {
  const refs = m.memory ?? [];
  if (refs.length === 0) return null;
  return (
    <section className="module-settings-modal__section module-memory">
      <h3>Where this lives</h3>
      <p className="module-settings-modal__hint">
        Storage this module reads or writes. Same convention used in{' '}
        <code>docs/memory.md</code>.
      </p>
      <ul className="module-memory__list">
        {refs.map((r, i) => (
          <li key={`${r.location}-${i}`} className="module-memory__row">
            <div className="module-memory__head">
              <span
                className={`module-memory__kind module-memory__kind--${r.kind}`}
                title={r.kind}
              >
                {kindGlyph(r.kind)}
              </span>
              <span className="module-memory__label">{r.label}</span>
              <span
                className={`module-memory__access module-memory__access--${r.access}`}
                title={`access: ${r.access}`}
              >
                {r.access}
              </span>
            </div>
            <code className="module-memory__location">{r.location}</code>
            {r.notes && <p className="module-memory__notes">{r.notes}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function kindGlyph(kind: NonNullable<ModuleSummary['memory']>[number]['kind']): string {
  switch (kind) {
    case 'file':
      return '📄';
    case 'directory':
      return '📁';
    case 'keychain':
      return '🔐';
    case 'sqlite':
      return '🗃';
    case 'config':
      return '⚙';
    case 'memory':
      return '◉';
  }
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
            moduleId={m.id}
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
  moduleId,
  field,
  value,
  onChange,
}: {
  moduleId: string;
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
        {field.type === 'secret' && (
          <SecretField moduleId={moduleId} fieldKey={field.key} />
        )}
      </div>
    </label>
  );
}

/**
 * Render a Keychain-backed credential. Doesn't read the secret value
 * (it's write-only from the renderer's POV); just toggles between
 * "set / not set" + offers Replace / Clear. Wiring per module is
 * hardcoded — extend the switch when more modules grow secret fields.
 */
function SecretField({
  moduleId,
  fieldKey,
}: {
  moduleId: string;
  fieldKey: string;
}) {
  const handlers = secretHandlersFor(moduleId, fieldKey);
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!handlers) return;
    let cancelled = false;
    void handlers.has().then((v) => {
      if (!cancelled) setHasToken(v);
    });
    return () => {
      cancelled = true;
    };
  }, [handlers]);

  if (!handlers) {
    return (
      <span className="module-settings__field-hint">
        (No secret handler wired for {moduleId}.{fieldKey})
      </span>
    );
  }

  const save = async (): Promise<void> => {
    if (!draft.trim()) {
      toast({ kind: 'error', message: 'Token cannot be empty' });
      return;
    }
    setBusy(true);
    try {
      await handlers.set(draft.trim());
      toast({ kind: 'success', message: 'Saved to Keychain' });
      setEditing(false);
      setDraft('');
      setHasToken(true);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    try {
      await handlers.clear();
      toast({ kind: 'success', message: 'Removed from Keychain' });
      setHasToken(false);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const helperUrl = helperUrlFor(moduleId, fieldKey);
  const helperLabel = helperLabelFor(moduleId, fieldKey);

  if (editing) {
    return (
      <div className="module-settings__secret">
        <input
          type="password"
          value={draft}
          autoFocus
          placeholder="Paste your token"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') {
              setEditing(false);
              setDraft('');
            }
          }}
        />
        <button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setDraft('');
          }}
          disabled={busy}
        >
          Cancel
        </button>
        {helperUrl && (
          <button
            className="module-settings__secret-helper"
            onClick={() => void window.jarvis.openExternal(helperUrl)}
            title={`Open ${helperLabel} to generate / manage tokens`}
          >
            ↗ {helperLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="module-settings__secret">
      <span className="module-settings__secret-status">
        {hasToken === null
          ? 'Checking…'
          : hasToken
            ? '✓ Token saved'
            : 'Not set'}
      </span>
      <button onClick={() => setEditing(true)} disabled={busy}>
        {hasToken ? 'Replace' : 'Set token'}
      </button>
      {hasToken && (
        <button onClick={() => void clear()} disabled={busy}>
          Clear
        </button>
      )}
      {helperUrl && (
        <button
          className="module-settings__secret-helper"
          onClick={() => void window.jarvis.openExternal(helperUrl)}
          title={`Open ${helperLabel} to generate / manage tokens`}
        >
          ↗ {helperLabel}
        </button>
      )}
    </div>
  );
}

/**
 * URL to surface as a "↗ Open X" helper next to the secret field, for
 * modules whose token source is a well-known web destination. V1 wires
 * BotFather for the Telegram bot.
 */
function helperUrlFor(moduleId: string, fieldKey: string): string | null {
  if (moduleId === 'telegram-bot' && fieldKey === 'botToken') {
    return 'https://t.me/BotFather';
  }
  return null;
}

function helperLabelFor(moduleId: string, fieldKey: string): string {
  if (moduleId === 'telegram-bot' && fieldKey === 'botToken') {
    return '@BotFather';
  }
  return 'docs';
}

/** Map (moduleId, fieldKey) → Keychain IPC handlers. V1 wires telegram-bot. */
function secretHandlersFor(
  moduleId: string,
  fieldKey: string,
): { has: () => Promise<boolean>; set: (v: string) => Promise<void>; clear: () => Promise<void> } | null {
  if (moduleId === 'telegram-bot' && fieldKey === 'botToken') {
    return {
      has: () => window.jarvis.hasTelegramBotToken(),
      set: (v) => window.jarvis.setTelegramBotToken(v),
      clear: () => window.jarvis.clearTelegramBotToken(),
    };
  }
  return null;
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
