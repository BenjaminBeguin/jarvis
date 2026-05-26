import { useEffect, useRef, useState } from 'react';

import type {
  AppStatus,
  AuthMode,
  HttpApiStatus,
  InboxPrefs,
  InboxSourceSummary,
  NotificationPrefs,
  ProjectDef,
  SkillSummary,
  WorkflowDef,
} from '../../shared/types';
import { DEFAULT_INBOX_PREFS } from '../../shared/types';
import { AutopilotPanel } from './autopilot/AutopilotPanel';
import { BrowserExtensionPanel } from './BrowserExtensionPanel';
import { Integrations } from './integrations/Integrations';
import { BuilderPanel } from './BuilderPanel';
import { MobilePairingPanel } from './MobilePairingPanel';
import { ModulesPage } from './ModulesPage';
import { SpendPanel } from './SpendPanel';
import { toast } from './Toaster';

type Section =
  | 'general'
  | 'preferences'
  | 'notifications'
  | 'inbox'
  | 'autopilot'
  | 'modules'
  | 'integrations'
  | 'api'
  | 'spend'
  | 'builder'
  | 'mobile'
  | 'browser';

interface Props {
  status: AppStatus;
  /** When the user clicks a module-page tile inside Settings → Modules. */
  onOpenModulePage: (id: string) => void;
  /** Optional initial section — lets the auth badge deep-link to General. */
  initialSection?: Section;
  /** Called once the initial section has been consumed, so the Shell can
   *  clear its sticky deep-link state and the next visit starts on
   *  'general' unless explicitly redirected again. */
  onInitialSectionConsumed?: () => void;
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
export function Settings({
  status,
  onOpenModulePage,
  initialSection,
  onInitialSectionConsumed,
}: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? 'general');
  useEffect(() => {
    if (initialSection) onInitialSectionConsumed?.();
    // Only fire when the initial section was actually used on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <SectionTab name="notifications" active={section} onClick={setSection}>
          Notifications
        </SectionTab>
        <SectionTab name="inbox" active={section} onClick={setSection}>
          Inbox
        </SectionTab>
        <SectionTab name="autopilot" active={section} onClick={setSection}>
          Autopilot
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
        <SectionTab name="spend" active={section} onClick={setSection}>
          Spend
        </SectionTab>
        <SectionTab name="builder" active={section} onClick={setSection}>
          Builder
        </SectionTab>
        <SectionTab name="mobile" active={section} onClick={setSection}>
          Mobile
        </SectionTab>
        <SectionTab name="browser" active={section} onClick={setSection}>
          Browser
        </SectionTab>
      </aside>
      <main className="settings__panel">
        {section === 'general' && <GeneralPanel status={status} />}
        {section === 'preferences' && <PreferencesPanel />}
        {section === 'notifications' && (
          <>
            <NotificationsPanel />
            <SpeedPanel />
          </>
        )}
        {section === 'inbox' && <InboxPanel />}
        {section === 'autopilot' && <AutopilotPanel />}
        {section === 'modules' && <ModulesPage onOpenPage={onOpenModulePage} />}
        {section === 'integrations' && <Integrations />}
        {section === 'api' && <ApiPanel />}
        {section === 'spend' && <SpendPanel />}
        {section === 'builder' && (
          <div className="settings__section">
            <BuilderPanel status={status} />
          </div>
        )}
        {section === 'mobile' && (
          <div className="settings__section">
            <MobilePairingPanel />
          </div>
        )}
        {section === 'browser' && <BrowserExtensionPanel />}
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

      <h3 style={{ marginTop: 24 }}>How Jarvis fits together</h3>
      <p className="settings__hint">
        A quick mental model so the tabs make sense:
      </p>
      <ul className="settings__concept-list">
        <li>
          <strong>Skill</strong> — a SKILL.md file under{' '}
          <code>~/.jarvis/skills/</code>. The prompt that tells Claude
          how to do one kind of thing. Composable.
        </li>
        <li>
          <strong>Routine</strong> — a cron entry that fires a skill on
          schedule. Optionally has a <code>condition</code> shell command
          gate ("watch"). Lives in <code>~/.jarvis/routines.json</code>;
          managed from the Routines tab.
        </li>
        <li>
          <strong>Module</strong> — TypeScript that registers palette
          intents and capabilities (quick-note, meeting-recorder,
          /send, /sh, …). Managed in Settings → Modules.
        </li>
        <li>
          <strong>Project</strong> — a named codebase scope (name +
          aliases + repo + path). When set as active scope, tasks run
          with that cwd and skills load the project's memory.
        </li>
        <li>
          <strong>Inbox</strong> — aggregated "things waiting on you".
          Sources include PRs, reminders, failed routines, and any
          skill that writes <code>~/.jarvis/inbox/*.json</code> (see
          <code>docs/scenarios.md</code>).
        </li>
        <li>
          <strong>Briefing</strong> — a markdown file generated by a
          routine whose skill writes to <code>~/.jarvis/briefings/&lt;kind&gt;/</code>.
          The Routines tab renders the file inline per routine. Pin a
          briefing routine to the Dashboard for one-glance reading.
        </li>
      </ul>
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
    <>
      <WorkingHoursPanel />
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
          <button
            onClick={() => void window.jarvis.revealPreferences()}
            disabled={busy}
          >
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
    </>
  );
}

/**
 * Working-hours pref. Drives the `{businessHours}` token in every
 * workflow cron that opts in (Slack / Linear / inbox-curate by
 * default) — one setting, all feeds. Saving resyncs the workflow
 * scheduler so existing jobs pick up the new window immediately.
 */
function WorkingHoursPanel() {
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);
  const [daysOfWeek, setDaysOfWeek] = useState('1-5');
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.workingHoursRead().then((prefs) => {
      if (cancelled) return;
      setStartHour(prefs.startHour);
      setEndHour(prefs.endHour);
      setDaysOfWeek(prefs.daysOfWeek);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (): Promise<void> => {
    const r = await window.jarvis.workingHoursWrite({
      startHour,
      endHour,
      daysOfWeek,
    });
    if (!r.ok) {
      toast({ kind: 'error', message: r.message ?? 'Save failed' });
      return;
    }
    setSavedAt(Date.now());
    toast({ message: 'Working hours saved · scheduler resynced' });
  };

  return (
    <div className="settings__section">
      <h3>Working hours</h3>
      <p className="settings__hint">
        Drives the <code>{'{businessHours}'}</code> cron token in workflow
        triggers. Slack, Linear, and the smart-inbox curator default to
        this window — one knob, every feed. Saving resyncs running cron
        jobs immediately.
      </p>
      <div className="settings__row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          title="Hour of day (0–23) when your working window starts"
        >
          Start
          <input
            type="number"
            min={0}
            max={23}
            value={startHour}
            disabled={!loaded}
            onChange={(e) =>
              setStartHour(Math.max(0, Math.min(23, Number(e.target.value) || 0)))
            }
            style={{ width: 64 }}
          />
        </label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          title="Hour of day (0–23) when your working window ends — inclusive (end-of-hour)"
        >
          End
          <input
            type="number"
            min={0}
            max={23}
            value={endHour}
            disabled={!loaded}
            onChange={(e) =>
              setEndHour(Math.max(0, Math.min(23, Number(e.target.value) || 0)))
            }
            style={{ width: 64 }}
          />
        </label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          title="POSIX cron day-of-week field. 0 or 7 = Sunday. Examples: 1-5 (Mon-Fri), 1-6 (Mon-Sat), 0-6 (every day)"
        >
          Days
          <input
            type="text"
            value={daysOfWeek}
            disabled={!loaded}
            onChange={(e) => setDaysOfWeek(e.target.value)}
            placeholder="1-5"
            style={{ width: 88 }}
          />
        </label>
        <button
          className="settings__primary"
          onClick={() => void save()}
          disabled={!loaded}
        >
          Save
        </button>
        {savedAt !== null && (
          <small className="settings__hint settings__hint--dim">
            applied {new Date(savedAt).toLocaleTimeString()}
          </small>
        )}
      </div>
      <p className="settings__hint settings__hint--dim" style={{ marginTop: 8 }}>
        Resolves to <code>{startHour}-{endHour} * * {daysOfWeek}</code>{' '}
        (POSIX cron). A workflow with{' '}
        <code>{'*/15 {businessHours}'}</code> fires every 15 minutes during
        this window.
      </p>
    </div>
  );
}

/**
 * Two knobs:
 *   - onAsk: what happens when the agent transitions to awaiting input
 *     on a user-initiated task (palette / voice). 'open' = auto-pop the
 *     Observatory (used to be the only behavior; some users find it
 *     too aggressive). 'toast' = system notification only. 'silent' =
 *     nothing — the task's status flips on the constellation, but no
 *     interruption.
 *   - onLaunch: when a /command actually starts. 'toast' surfaces it so
 *     /review-prs doesn't disappear into the background; 'silent' if
 *     you find the HUD overlay enough.
 */
function NotificationsPanel() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.readNotificationPrefs().then((p) => {
      if (!cancelled) setPrefs(p);
    });
    const off = window.jarvis.onNotificationPrefsChanged(setPrefs);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (!prefs) {
    return <div className="settings__section">Loading…</div>;
  }

  const update = async (patch: Partial<NotificationPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next); // optimistic
    try {
      await window.jarvis.writeNotificationPrefs(next);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="settings__section">
      <h3>Notifications</h3>
      <p className="settings__hint">
        How loud Jarvis is when an agent needs you or when a command
        starts. Affects palette / voice tasks only — routine fires
        always go through the quieter "toast" path.
      </p>

      <NotifChoice
        label="When the agent asks me something"
        hint="Mid-task, the agent might need a confirmation, a missing recipient, etc."
        value={prefs.onAsk}
        onChange={(v) => void update({ onAsk: v })}
        options={[
          {
            value: 'silent',
            label: 'Silent',
            blurb: 'Status flips on the constellation. No popup, no sound.',
          },
          {
            value: 'toast',
            label: 'Toast',
            blurb:
              'macOS notification — click to jump into the conversation.',
          },
          {
            value: 'open',
            label: 'Open conversation',
            blurb:
              'Auto-foreground the Observatory and select the task. Most invasive.',
          },
        ]}
      />

      <NotifChoice
        label="When a command launches a task"
        hint="So /review-prs and friends don't quietly start in the background."
        value={prefs.onLaunch}
        onChange={(v) => void update({ onLaunch: v })}
        options={[
          {
            value: 'silent',
            label: 'Silent',
            blurb: 'The HUD overlay still streams; no separate signal.',
          },
          {
            value: 'toast',
            label: 'Toast',
            blurb:
              'Silent macOS notification — gives you a glanceable "started" pill.',
          },
        ]}
      />
    </div>
  );
}

/**
 * Speed bias panel — tier-routing knob that applies to EVERY skill
 * launched (unless the skill pinned an explicit model in its
 * frontmatter). The default is `auto` which honours each skill's
 * declared tier. `prefer-fast` shifts everything one tier toward
 * haiku for snappier responses; `force-*` clamps everything.
 *
 * The control lives under Notifications since both are "how the
 * cockpit behaves" preferences. A dedicated Performance tab is
 * overkill for a single setting.
 */
function SpeedPanel() {
  const [bias, setBias] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.readSpeedBias().then((b) => {
      if (!cancelled) setBias(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!bias) {
    return <div className="settings__section">Loading…</div>;
  }

  const update = async (next: string) => {
    setBias(next); // optimistic
    try {
      const confirmed = await window.jarvis.writeSpeedBias(next);
      setBias(confirmed);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="settings__section">
      <h3>Model speed</h3>
      <p className="settings__hint">
        Every skill declares a tier (<code>fast</code> = haiku,{' '}
        <code>balanced</code> = sonnet, <code>smart</code> = opus). This
        knob shifts ALL of them in one place. Skills that pin an
        explicit <code>model:</code> in their frontmatter ignore this —
        on purpose, so a skill that genuinely needs opus stays opus.
      </p>

      <NotifChoice
        label="Bias"
        hint="Picks the model tier for every task. Default 'auto' respects each skill's choice."
        value={bias}
        onChange={(v) => void update(v)}
        options={[
          {
            value: 'auto',
            label: 'Auto (default)',
            blurb:
              'Use each skill\'s declared tier. inbox-curate stays on haiku, work-awareness-calibrate stays on sonnet, etc.',
          },
          {
            value: 'prefer-fast',
            label: 'Prefer fast',
            blurb:
              'Shift everything down one tier. Balanced → fast (haiku). Smart → balanced (sonnet). Snappy default for daily flow.',
          },
          {
            value: 'prefer-smart',
            label: 'Prefer smart',
            blurb:
              'Shift everything up one tier. Fast → balanced (sonnet). Balanced → smart (opus). When quality matters more than latency.',
          },
          {
            value: 'force-fast',
            label: 'Force fast',
            blurb:
              'Everything runs on haiku. Cheapest + fastest; quality drops for complex skills.',
          },
          {
            value: 'force-balanced',
            label: 'Force balanced',
            blurb: 'Everything runs on sonnet. Reasonable middle ground.',
          },
          {
            value: 'force-smart',
            label: 'Force smart',
            blurb:
              'Everything runs on opus. Expensive — only for high-stakes runs you\'re going to babysit.',
          },
        ]}
      />
    </div>
  );
}

interface NotifChoiceOption<T extends string> {
  value: T;
  label: string;
  blurb: string;
}

function NotifChoice<T extends string>({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint: string;
  value: T;
  onChange: (next: T) => void;
  options: NotifChoiceOption<T>[];
}) {
  return (
    <div className="notif-choice">
      <div className="notif-choice__head">
        <div className="notif-choice__label">{label}</div>
        <div className="notif-choice__hint">{hint}</div>
      </div>
      <div className="notif-choice__opts">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`notif-choice__opt${
              opt.value === value ? ' notif-choice__opt--active' : ''
            }`}
            onClick={() => onChange(opt.value)}
          >
            <div className="notif-choice__opt-label">{opt.label}</div>
            <div className="notif-choice__opt-blurb">{opt.blurb}</div>
          </button>
        ))}
      </div>
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

      <h3 style={{ marginTop: 28 }}>Jarvis MCP (in-process)</h3>
      <p className="settings__hint">
        A second, fundamentally different surface: an in-process{' '}
        <strong>MCP server</strong> registered automatically with every
        agent task. Lets a Claude run inside Jarvis call back into Jarvis
        without leaving the model loop — pop a notification, log an
        activity row, schedule a reminder, read the active project. Runs
        as a programmatic SDK MCP, no subprocess, no auth, no IPC dance.
        Tools appear in agent context as <code>mcp__jarvis__&lt;name&gt;</code>.
      </p>
      <p className="settings__hint settings__hint--dim">
        Skills with restrictive <code>allowed-tools</code> in their
        frontmatter can scope or exclude individual tools (e.g.
        <code> allowed-tools: [Read, mcp__jarvis__notify]</code> for a
        skill that's only allowed to notify). Skills with no
        <code> allowed-tools</code> get the full set.
      </p>

      <h4 className="settings__subhead">Tools</h4>
      <ul className="settings__endpoints">
        <li>
          <code>mcp__jarvis__notify</code> — pop a macOS notification
          ({'{ title, body }'})
        </li>
        <li>
          <code>mcp__jarvis__log_activity</code> — append a row to the
          Activity feed ({'{ kind, label, detail? }'})
        </li>
        <li>
          <code>mcp__jarvis__create_reminder</code> — schedule a future
          reminder or scheduled action ({'{ body, mode, fireAt, cron? }'}). Pass
          a 5-field cron expression to make it recurring.
        </li>
        <li>
          <code>mcp__jarvis__open_url</code> — open a URL in the default
          browser ({'{ url }'})
        </li>
        <li>
          <code>mcp__jarvis__get_active_project</code> — currently scoped
          project ({'{ name, path?, repo? }'} or null)
        </li>
        <li>
          <code>mcp__jarvis__list_recent_meetings</code> /{' '}
          <code>list_recent_notes</code> — recent file enumeration
          ({'{ project?, limit? }'})
        </li>
        <li>
          <code>mcp__jarvis__read_project_memory</code> /{' '}
          <code>write_project_memory</code> — per-project markdown memory
        </li>
      </ul>

      <h4 className="settings__subhead">When to use</h4>
      <p className="settings__hint">
        Prefer these over Bash equivalents — they're faster and keep the
        transcript clean. <code>notify</code> beats <code>osascript -e
        'display notification'</code>; <code>log_activity</code> beats
        writing your own progress text. The system prompt for every task
        already advertises these so the agent knows they exist.
      </p>

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

/**
 * Per-project checklist controlling which repos the PR inbox sources
 * scan. Default: scan all tracked projects that have a `repo` field.
 * Untick a row to exclude that project — persisted as
 * `inboxScan: false` on the project entry in projects.json.
 */
function InboxPanel() {
  const [projects, setProjects] = useState<ProjectDef[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sources, setSources] = useState<InboxSourceSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [inboxPrefs, setInboxPrefs] = useState<InboxPrefs>(DEFAULT_INBOX_PREFS);

  useEffect(() => {
    void window.jarvis.listProjects().then(setProjects);
    return window.jarvis.onProjectsChanged(setProjects);
  }, []);

  useEffect(() => {
    void window.jarvis.readInboxPrefs().then(setInboxPrefs);
    const off = window.jarvis.onInboxPrefsChanged(setInboxPrefs);
    return off;
  }, []);

  const toggleSource = async (name: string, enable: boolean) => {
    const set = new Set(inboxPrefs.disabledSources);
    if (enable) set.delete(name);
    else set.add(name);
    const next: InboxPrefs = { ...inboxPrefs, disabledSources: [...set] };
    setInboxPrefs(next); // optimistic
    try {
      await window.jarvis.writeInboxPrefs(next);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Reload sources whenever skills or the inbox content changes — that
  // covers "user dropped a new SKILL.md that writes inbox/x.json" and
  // "routine just refreshed inbox/x.json with new item counts."
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const skillList = await window.jarvis.listSkills();
      if (cancelled) return;
      setSkills(skillList);
      const ids = skillList.map((s) => s.id);
      const rows = await window.jarvis.listInboxSources(ids);
      if (cancelled) return;
      setSources(rows);
    };
    void refresh();
    const offInbox = window.jarvis.onInboxChanged(() => void refresh());
    return () => {
      cancelled = true;
      offInbox();
    };
  }, []);

  const projectsWithRepo = projects.filter((p) => p.repo);
  const allOff = projectsWithRepo.every((p) => p.inboxScan === false);

  const toggle = async (project: ProjectDef) => {
    setBusy(project.name);
    try {
      const next = project.inboxScan === false; // currently off → turn on
      await window.jarvis.setProjectInboxScan(project.name, next);
      toast({
        message: `${project.name}: PR scanning ${next ? 'enabled' : 'disabled'}`,
      });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings__section">
      <h3>Sources</h3>
      <p className="settings__hint">
        Everything that feeds the Inbox tab. Built-in sources are baked in;
        the others come from skills writing JSON to{' '}
        <code>~/.jarvis/inbox/&lt;name&gt;.json</code>.
      </p>
      <InboxSourcesList
        sources={sources}
        skills={skills}
        disabledSources={new Set(inboxPrefs.disabledSources)}
        onToggle={toggleSource}
      />

      {!inboxPrefs.disabledSources.includes('calendar') && (
        <div className="inbox-pref-row">
          <div className="inbox-pref-row__label">Calendar window</div>
          <div className="inbox-pref-row__hint">
            How many hours into the future the Inbox shows meetings.
            Events past this window stay visible in the Calendar tab
            and the Dashboard timeline — they're just hidden from the
            triage feed.
          </div>
          <div className="inbox-pref-row__input">
            <input
              type="number"
              min={1}
              max={744}
              step={1}
              value={inboxPrefs.calendarWindowHours}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isFinite(n) || n <= 0) return;
                void window.jarvis.writeInboxPrefs({
                  ...inboxPrefs,
                  calendarWindowHours: Math.min(n, 744),
                });
              }}
            />
            <span className="inbox-pref-row__unit">hours</span>
            <div className="inbox-pref-row__chips">
              {[12, 24, 48, 168].map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`inbox-pref-row__chip${
                    inboxPrefs.calendarWindowHours === h
                      ? ' inbox-pref-row__chip--active'
                      : ''
                  }`}
                  onClick={() =>
                    void window.jarvis.writeInboxPrefs({
                      ...inboxPrefs,
                      calendarWindowHours: h,
                    })
                  }
                >
                  {h === 168 ? '1 week' : `${h}h`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 28 }}>PR inbox scope</h3>
      <p className="settings__hint">
        The PR inbox sources (Reviews waiting on you, Comments on your PRs)
        scan repos for activity. By default they scan every tracked
        project that has a <code>repo</code> field. Untick a row to skip
        that one — keeps the noise down when you're not actively in a
        codebase.
      </p>

      {projectsWithRepo.length === 0 && (
        <div className="settings__hint settings__hint--dim">
          No tracked projects have a <code>repo</code> set yet. Add one
          via the Projects tab + New, or edit <code>~/.jarvis/projects.json</code>{' '}
          directly. With no repos configured, the PR sources scan
          everything <code>gh</code> can see.
        </div>
      )}

      {projectsWithRepo.length > 0 && (
        <>
          <ul className="settings__scan-list">
            {projectsWithRepo.map((p) => {
              const enabled = p.inboxScan !== false;
              return (
                <li key={p.name} className="settings__scan-row">
                  <label className="settings__scan-label">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={busy === p.name}
                      onChange={() => void toggle(p)}
                    />
                    <span className="settings__scan-name">{p.name}</span>
                    <code className="settings__scan-repo">{p.repo}</code>
                  </label>
                </li>
              );
            })}
          </ul>
          {allOff && (
            <div className="settings__hint settings__hint--dim">
              All projects are disabled. PR sources will return nothing
              until you re-enable at least one above.
            </div>
          )}
        </>
      )}

      <h4 className="settings__subhead">How the accuracy works</h4>
      <p className="settings__hint">
        Refreshes are smart: <strong>Comments on your PRs</strong> only
        surfaces PRs with at least one unresolved thread where the last
        comment isn't you (or PRs in <code>CHANGES_REQUESTED</code>{' '}
        state). <strong>Reviews waiting on you</strong> only surfaces
        PRs where you haven't submitted a review yet. Items you've
        already replied to drop out automatically on the next refresh.
      </p>

      <h3 style={{ marginTop: 28 }}>Slack tracking</h3>
      <p className="settings__hint">
        DMs to you and explicit @mentions of you are tracked by default.
        Add channels you want surfaced even without an @ (mirror the
        ones grouped under your Jarvis sidebar section in Slack) and
        people whose every message you care about. Edits rewrite the
        query in <code>~/.jarvis/workflows/slack-inbox-sync.json</code>.
      </p>
      <SlackTrackingPanel />
    </div>
  );
}

/**
 * Add/remove tracked Slack channels + people. The source of truth
 * is the slack-inbox-sync workflow's http-fetch query body — we
 * parse the OR-branches on read and rewrite the whole string on
 * save. Two lists, two add buttons, chips with × to remove.
 */
function SlackTrackingPanel() {
  const [channels, setChannels] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [newChannel, setNewChannel] = useState('');
  const [newUser, setNewUser] = useState('');
  const [workflow, setWorkflow] = useState<WorkflowDef | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const { workflows } = await window.jarvis.listWorkflows();
      if (cancelled) return;
      const wf = workflows.find((w) => w.id === 'slack-inbox-sync');
      setWorkflow(wf ?? null);
      const query = readQuery(wf);
      if (query === null) {
        setParseError(
          'Could not find the Slack workflow. Open Workflows and check it exists.',
        );
        return;
      }
      const parsed = parseSlackQuery(query);
      setChannels(parsed.channels);
      setUsers(parsed.users);
      setParseError(parsed.unrecognized ? UNRECOGNIZED_HINT : null);
    };
    void refresh();
    const off = window.jarvis.onWorkflowsChanged(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const persist = async (
    nextChannels: string[],
    nextUsers: string[],
  ): Promise<void> => {
    if (!workflow) return;
    const updated = updateWorkflowQuery(workflow, nextChannels, nextUsers);
    if (!updated) {
      toast({
        kind: 'error',
        message: 'Workflow shape changed — edit the JSON directly.',
      });
      return;
    }
    setChannels(nextChannels);
    setUsers(nextUsers);
    try {
      const res = await window.jarvis.saveWorkflow(updated);
      if (!res.ok) {
        toast({ kind: 'error', message: res.message ?? 'Save failed' });
      }
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const addChannel = (): void => {
    const v = normaliseChannel(newChannel);
    if (!v) return;
    if (channels.includes(v)) {
      setNewChannel('');
      return;
    }
    setNewChannel('');
    void persist([...channels, v], users);
  };

  const addUser = (): void => {
    const v = normaliseUser(newUser);
    if (!v) return;
    if (users.includes(v)) {
      setNewUser('');
      return;
    }
    setNewUser('');
    void persist(channels, [...users, v]);
  };

  return (
    <div className="slack-tracking">
      {parseError && (
        <div className="settings__hint settings__hint--dim">{parseError}</div>
      )}

      <div className="slack-tracking__group">
        <div className="slack-tracking__label">Channels</div>
        <div className="slack-tracking__chips">
          {channels.length === 0 && (
            <span className="slack-tracking__empty">None added yet.</span>
          )}
          {channels.map((c) => (
            <span key={c} className="slack-tracking__chip">
              #{c}
              <button
                type="button"
                onClick={() =>
                  void persist(
                    channels.filter((x) => x !== c),
                    users,
                  )
                }
                aria-label={`Remove #${c}`}
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="slack-tracking__add">
          <input
            type="text"
            value={newChannel}
            onChange={(e) => setNewChannel(e.target.value)}
            placeholder="csai-epd-ops"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addChannel();
              }
            }}
          />
          <button type="button" onClick={addChannel}>
            Add
          </button>
        </div>
      </div>

      <div className="slack-tracking__group">
        <div className="slack-tracking__label">People</div>
        <div className="slack-tracking__chips">
          {users.length === 0 && (
            <span className="slack-tracking__empty">None added yet.</span>
          )}
          {users.map((u) => (
            <span key={u} className="slack-tracking__chip">
              @{u}
              <button
                type="button"
                onClick={() =>
                  void persist(
                    channels,
                    users.filter((x) => x !== u),
                  )
                }
                aria-label={`Remove @${u}`}
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="slack-tracking__add">
          <input
            type="text"
            value={newUser}
            onChange={(e) => setNewUser(e.target.value)}
            placeholder="elisa.ramos"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addUser();
              }
            }}
          />
          <button type="button" onClick={addUser}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

const UNRECOGNIZED_HINT =
  "The Slack workflow's query contains modifiers we don't parse — channels / people you add here are appended cleanly, but the rest is preserved as-is.";

function readQuery(wf: WorkflowDef | null | undefined): string | null {
  if (!wf) return null;
  const fetch = wf.pipeline.find((n) => n.type === 'http-fetch');
  if (!fetch) return null;
  const body = (fetch.params as { body?: Record<string, unknown> }).body;
  const q = body?.['query'];
  return typeof q === 'string' ? q : null;
}

function parseSlackQuery(query: string): {
  channels: string[];
  users: string[];
  unrecognized: boolean;
} {
  const channels: string[] = [];
  const users: string[] = [];
  for (const m of query.matchAll(/in:#?([a-z0-9._-]+)/gi)) {
    if (m[1] && !channels.includes(m[1])) channels.push(m[1]);
  }
  for (const m of query.matchAll(/from:([a-z0-9._-]+)/gi)) {
    if (m[1] && m[1] !== 'me' && !users.includes(m[1])) users.push(m[1]);
  }
  // Heuristic: the default contains to:me + mentions:me. If we see
  // something else inside the parens, flag it so we don't claim full
  // ownership over the query string.
  const stripped = query
    .replace(/in:#?[a-z0-9._-]+/gi, '')
    .replace(/from:[a-z0-9._-]+/gi, '')
    .replace(/to:me/g, '')
    .replace(/mentions:me/g, '')
    .replace(/[()\s]|OR|-/g, '');
  return { channels, users, unrecognized: stripped.length > 0 };
}

function buildSlackQuery(channels: string[], users: string[]): string {
  const branches = ['to:me', 'mentions:me'];
  for (const c of channels) branches.push(`in:#${c}`);
  for (const u of users) branches.push(`from:${u}`);
  return `(${branches.join(' OR ')}) -from:me`;
}

function updateWorkflowQuery(
  wf: WorkflowDef,
  channels: string[],
  users: string[],
): WorkflowDef | null {
  const idx = wf.pipeline.findIndex((n) => n.type === 'http-fetch');
  if (idx === -1) return null;
  const node = wf.pipeline[idx]!;
  const params = (node.params ?? {}) as Record<string, unknown>;
  const body = ((params['body'] ?? {}) as Record<string, unknown>);
  const nextBody = { ...body, query: buildSlackQuery(channels, users) };
  const nextParams = { ...params, body: nextBody };
  const nextPipeline = wf.pipeline.map((n, i) =>
    i === idx ? { ...n, params: nextParams } : n,
  );
  return { ...wf, pipeline: nextPipeline };
}

function normaliseChannel(input: string): string | null {
  const trimmed = input.trim().replace(/^#/, '');
  if (!trimmed) return null;
  // Slack channel names: a-z, 0-9, -, _, ., max 80 chars.
  if (!/^[a-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

function normaliseUser(input: string): string | null {
  const trimmed = input.trim().replace(/^@/, '');
  if (!trimmed) return null;
  if (trimmed === 'me') return null;
  if (!/^[a-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Read-only inspector for the inbox sources. Each row shows where the
 * data comes from, current count, and the most useful shortcut:
 *   - PR sources → "Configure scope" jumps to the panel below
 *   - Failed routines → opens the Routines tab
 *   - Reminders → opens the Inbox tab (where reminders show up)
 *   - File-backed (skill-written) → "Reveal in Finder" + (if the file
 *     name matches a skill id) "Open skill"
 */
function InboxSourcesList({
  sources,
  skills,
  disabledSources,
  onToggle,
}: {
  sources: InboxSourceSummary[];
  skills: SkillSummary[];
  disabledSources: Set<string>;
  onToggle: (name: string, enable: boolean) => void;
}) {
  if (sources.length === 0) {
    return (
      <div className="settings__hint settings__hint--dim">
        No sources registered yet — boot the app and check back.
      </div>
    );
  }
  return (
    <ul className="inbox-sources">
      {sources.map((src) => (
        <InboxSourceRow
          key={src.name}
          src={src}
          skills={skills}
          enabled={!disabledSources.has(src.name)}
          onToggle={(v) => onToggle(src.name, v)}
        />
      ))}
    </ul>
  );
}

function InboxSourceRow({
  src,
  skills,
  enabled,
  onToggle,
}: {
  src: InboxSourceSummary;
  skills: SkillSummary[];
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const reveal = async () => {
    const r = await window.jarvis.revealInboxFile(`${src.name}.json`);
    if (!r.ok)
      toast({ kind: 'error', message: r.message ?? 'Reveal failed' });
  };
  const openSkill = () => {
    if (!src.relatedSkillId) return;
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', {
        detail: { tab: 'skills', skillId: src.relatedSkillId },
      }),
    );
  };
  const openRoutines = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', { detail: { tab: 'routines' } }),
    );
  };
  const openInbox = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
    );
  };
  const openIntegrations = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', {
        detail: { tab: 'settings', settingsSection: 'integrations' },
      }),
    );
  };
  const sk = src.relatedSkillId
    ? skills.find((s) => s.id === src.relatedSkillId)
    : undefined;

  return (
    <li className={`inbox-source${enabled ? '' : ' inbox-source--off'}`}>
      <div className="inbox-source__head">
        <label
          className="inbox-source__toggle"
          title={enabled ? 'Hide this source from the Inbox' : 'Show this source in the Inbox'}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
        </label>
        <span className="inbox-source__name">{src.label}</span>
        <span className={`inbox-source__kind inbox-source__kind--${src.kind}`}>
          {src.kind === 'built-in' ? 'built-in' : 'file'}
        </span>
        <span className="inbox-source__count">
          {src.itemCount} {src.itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>
      <div className="inbox-source__desc">
        {!enabled && <em>Hidden from Inbox. </em>}
        {src.description}
      </div>
      {src.kind === 'file' && (
        <div className="inbox-source__meta">
          <code>~/.jarvis/inbox/{src.name}.json</code>
          {src.mtimeMs && (
            <span> · last write {formatRelTime(src.mtimeMs)}</span>
          )}
          {sk && <span> · written by skill {sk.name}</span>}
        </div>
      )}
      <div className="inbox-source__actions">
        {src.kind === 'file' && (
          <button onClick={() => void reveal()}>Reveal in Finder</button>
        )}
        {src.configureHint === 'skill' && src.relatedSkillId && (
          <button onClick={openSkill}>Open skill ↗</button>
        )}
        {src.configureHint === 'routines' && (
          <button onClick={openRoutines}>Open Routines ↗</button>
        )}
        {src.configureHint === 'reminders' && (
          <button onClick={openInbox}>Open Inbox ↗</button>
        )}
        {src.configureHint === 'integrations' && (
          <button onClick={openIntegrations}>Open Integrations ↗</button>
        )}
      </div>
    </li>
  );
}

function formatRelTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
