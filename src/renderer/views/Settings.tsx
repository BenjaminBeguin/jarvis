import { useEffect, useRef, useState } from 'react';

import type { AppStatus, AuthMode, HttpApiStatus } from '../../shared/types';
import { Integrations } from './integrations/Integrations';
import { ModulesPage } from './ModulesPage';
import { toast } from './Toaster';

type Section = 'general' | 'preferences' | 'modules' | 'integrations' | 'api';

interface Props {
  status: AppStatus;
  /** When the user clicks a module-page tile inside Settings → Modules. */
  onOpenModulePage: (id: string) => void;
  /** Optional initial section — lets the auth badge deep-link to General. */
  initialSection?: Section;
}

/**
 * Settings tab — the single home for everything configuration. Replaces
 * the scattered "Modules" and "Integrations" top-level tabs plus the
 * "prefs" + "auth" header buttons. One tab, internal vertical sub-nav.
 *
 * Sections:
 *   - General   — auth mode + token management
 *   - Preferences — markdown editor for ~/.jarvis/preferences.md
 *   - Modules   — module manager (reuses ModulesPage)
 *   - Integrations — MCP servers + catalog (reuses Integrations)
 *   - API       — localhost HTTP API URL + token + rotate
 */
export function Settings({ status, onOpenModulePage, initialSection }: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? 'general');

  return (
    <section className="settings">
      <aside className="settings__nav">
        <h2 className="settings__nav-head">SETTINGS</h2>
        <SectionTab name="general" active={section} onClick={setSection}>
          General
        </SectionTab>
        <SectionTab name="preferences" active={section} onClick={setSection}>
          Preferences
        </SectionTab>
        <SectionTab name="modules" active={section} onClick={setSection}>
          Modules
        </SectionTab>
        <SectionTab name="integrations" active={section} onClick={setSection}>
          Integrations
        </SectionTab>
        <SectionTab name="api" active={section} onClick={setSection}>
          API
        </SectionTab>
      </aside>
      <main className="settings__panel">
        {section === 'general' && <GeneralPanel status={status} />}
        {section === 'preferences' && <PreferencesPanel />}
        {section === 'modules' && <ModulesPage onOpenPage={onOpenModulePage} />}
        {section === 'integrations' && <Integrations />}
        {section === 'api' && <ApiPanel />}
      </main>
    </section>
  );
}

function SectionTab({
  name,
  active,
  onClick,
  children,
}: {
  name: Section;
  active: Section;
  onClick: (s: Section) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`settings__nav-item${active === name ? ' settings__nav-item--active' : ''}`}
      onClick={() => onClick(name)}
    >
      {children}
    </button>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────

function GeneralPanel({ status }: { status: AppStatus }) {
  const switchAuth = async (mode: AuthMode) => {
    try {
      await window.jarvis.setAuthMode(mode);
      toast({ message: `Switched to ${mode === 'subscription' ? 'subscription' : 'API key'} mode` });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="settings__section">
      <h3>Auth mode</h3>
      <p className="settings__hint">
        Jarvis runs Claude either through your subscription (via the
        installed <code>claude</code> CLI + a setup-token) or with a
        direct Anthropic API key. Switch any time.
      </p>
      <div className="settings__auth-cards">
        <AuthCard
          title="Subscription"
          subtitle={
            !status.claudeBinaryPath
              ? 'claude CLI not detected'
              : !status.hasSubscriptionToken
                ? 'no setup-token saved'
                : 'CLI + token detected'
          }
          active={status.authMode === 'subscription'}
          disabled={!status.claudeBinaryPath || !status.hasSubscriptionToken}
          onSelect={() => void switchAuth('subscription')}
        />
        <AuthCard
          title="API key"
          subtitle={status.hasApiKey ? 'key on file' : 'no key — add one below'}
          active={status.authMode === 'api-key'}
          disabled={!status.hasApiKey}
          onSelect={() => void switchAuth('api-key')}
        />
      </div>
      <p className="settings__hint settings__hint--dim">
        Version <code>{status.version}</code>
        {status.claudeBinaryPath && (
          <> · <code>{status.claudeBinaryPath}</code></>
        )}
      </p>
    </div>
  );
}

function AuthCard({
  title,
  subtitle,
  active,
  disabled,
  onSelect,
}: {
  title: string;
  subtitle: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`settings__auth-card${active ? ' settings__auth-card--active' : ''}`}
      onClick={onSelect}
      disabled={disabled}
    >
      <div className="settings__auth-card-title">{title}</div>
      <div className="settings__auth-card-sub">{subtitle}</div>
      {active && <div className="settings__auth-card-badge">active</div>}
    </button>
  );
}

/**
 * Inline editor for ~/.jarvis/preferences.md. Mirrors what the old
 * PreferencesDialog modal did, but lives in a tab now.
 */
function PreferencesPanel() {
  const [path, setPath] = useState('');
  const [draft, setDraft] = useState('');
  const [original, setOriginal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBusy(true);
    void window.jarvis.readPreferences().then((res) => {
      if (cancelled) return;
      setPath(res.path);
      setDraft(res.contents);
      setOriginal(res.contents);
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.jarvis.onPreferencesChanged((contents: string) => {
      setOriginal(contents);
      if (draft === original) setDraft(contents);
    });
  }, [draft, original]);

  const dirty = draft !== original;

  const save = async () => {
    if (!dirty) return;
    setError(null);
    setBusy(true);
    try {
      await window.jarvis.writePreferences(draft);
      setOriginal(draft);
      toast({ message: 'Preferences saved · applied to every new task' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings__section">
      <h3>Preferences</h3>
      <p className="settings__hint">
        Prepended to every task's system prompt as{' '}
        <code>## User preferences</code>. Edit freely. <kbd>⌘S</kbd> to save.
      </p>
      <textarea
        ref={textareaRef}
        className="preferences-dialog__textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            void save();
          }
        }}
        spellCheck={false}
      />
      <div className="settings__row-actions">
        <small className="settings__hint settings__hint--dim" title={path}>
          {path}
        </small>
        <div style={{ flex: 1 }} />
        <button onClick={() => void window.jarvis.revealPreferences()} disabled={busy}>
          Reveal in Finder
        </button>
        <button
          className="settings__primary"
          onClick={() => void save()}
          disabled={busy || !dirty}
        >
          {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
      </div>
      {error && <div className="project-dialog__error">{error}</div>}
    </div>
  );
}

function ApiPanel() {
  const [status, setStatus] = useState<HttpApiStatus | null>(null);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    void window.jarvis.httpApiStatus().then(setStatus);
  }, []);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ message: `${label} copied` });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const rotate = async () => {
    if (
      !confirm(
        'Rotate the API token? Existing scripts / Shortcuts / clients ' +
          'using the old token will need to be updated.',
      )
    )
      return;
    setRotating(true);
    try {
      const res = await window.jarvis.rotateHttpApiToken();
      setStatus((s) =>
        s ? { ...s, token: res.token, url: res.url, running: res.url !== null } : null,
      );
      toast({ message: 'Token rotated' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRotating(false);
    }
  };

  if (!status) {
    return <div className="settings__section">Loading…</div>;
  }

  const curlExample = `curl -X POST ${status.url ?? 'http://127.0.0.1:4747'}/v1/intent \\
  -H "Authorization: Bearer ${status.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"remind me in 2h to ship the patch"}'`;

  return (
    <div className="settings__section">
      <h3>HTTP API</h3>
      <p className="settings__hint">
        Localhost endpoint for driving Jarvis from iOS Shortcuts, the
        terminal, CI, or any future external client. Bearer token auth;
        bound to <code>127.0.0.1</code> only — never exposed to the network.
      </p>

      <div className="settings__kv">
        <div className="settings__kv-label">Status</div>
        <div className="settings__kv-value">
          {status.running ? (
            <span className="settings__pill settings__pill--good">running</span>
          ) : (
            <span className="settings__pill settings__pill--bad">stopped (port in use?)</span>
          )}
        </div>
      </div>

      <div className="settings__kv">
        <div className="settings__kv-label">URL</div>
        <div className="settings__kv-value">
          <code>{status.url ?? '—'}</code>
          {status.url && (
            <button
              className="settings__inline-btn"
              onClick={() => void copy(status.url!, 'URL')}
            >
              copy
            </button>
          )}
        </div>
      </div>

      <div className="settings__kv">
        <div className="settings__kv-label">Token</div>
        <div className="settings__kv-value">
          <code className="settings__token">{status.token.slice(0, 12)}…</code>
          <button className="settings__inline-btn" onClick={() => void copy(status.token, 'Token')}>
            copy
          </button>
          <button className="settings__inline-btn" onClick={() => void rotate()} disabled={rotating}>
            {rotating ? 'rotating…' : 'rotate'}
          </button>
        </div>
      </div>

      <h4 className="settings__subhead">Try it</h4>
      <pre className="settings__code">{curlExample}</pre>

      <h4 className="settings__subhead">CLI</h4>
      <p className="settings__hint">
        The repo ships a tiny <code>jarvis</code> CLI at <code>cli/jarvis</code>{' '}
        that reads the token from Keychain — no env vars needed. Symlink it
        onto your PATH and run <code>jarvis status</code>, <code>jarvis run
        "&lt;prompt&gt;"</code>, <code>jarvis inbox</code>, etc. See{' '}
        <code>docs/cli.md</code> for the full reference.
      </p>

      <h4 className="settings__subhead">Available endpoints</h4>
      <ul className="settings__endpoints">
        <li>
          <code>GET /v1/status</code> — health, version (no auth)
        </li>
        <li>
          <code>POST /v1/intent</code> — route free text (task / reminder)
        </li>
        <li>
          <code>POST /v1/tasks</code> — launch a task ({'{ prompt, skillId? }'})
        </li>
        <li>
          <code>GET /v1/tasks</code> — recent tasks
        </li>
        <li>
          <code>GET /v1/tasks/:id</code> — task summary + events
        </li>
        <li>
          <code>POST /v1/tasks/:id/abort</code> — graceful stop
        </li>
        <li>
          <code>GET /v1/inbox</code>, <code>POST /v1/inbox/refresh</code> — inbox
        </li>
        <li>
          <code>POST /v1/reminders</code> — schedule
        </li>
      </ul>

      <h4 className="settings__subhead">Want more inbox sources?</h4>
      <p className="settings__hint">
        Drop a skill at <code>~/.jarvis/skills/&lt;name&gt;/SKILL.md</code> that
        writes <code>InboxItem[]</code> JSON to{' '}
        <code>~/.jarvis/inbox/&lt;name&gt;.json</code>, then add a routine
        to fire it on a schedule. Built-in patterns:{' '}
        <code>slack-inbox</code>, <code>linear-inbox</code>,{' '}
        <code>calendar-today</code>. Full pattern in <code>docs/scenarios.md</code>.
      </p>
    </div>
  );
}
