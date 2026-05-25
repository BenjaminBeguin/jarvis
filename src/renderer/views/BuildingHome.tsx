import { useEffect, useMemo, useState } from 'react';

import type {
  AppStatus,
  ConnectorSummary,
  WorkflowDef,
  WorkingHoursPrefs,
} from '../../shared/types';
import { SystemPulse } from './SystemPulse';

/**
 * BuildingHome — the landing page for "Building" mode.
 *
 * Combines the SystemPulse stats strip with a focused "needs your
 * attention" list. The list is computed from live state (auth,
 * integrations, workflow enable, policy file customization) and only
 * surfaces ACTIONABLE items. When everything's set, the list says so.
 *
 * Where this fits: SystemPulse used to live on the Dashboard, but
 * the Dashboard is for daily-driver work. Setup status belongs in
 * Building mode where the user is already in the "configure"
 * mindset.
 */

type TodoStatus = 'pending' | 'partial';

interface TodoItem {
  id: string;
  title: string;
  description: string;
  status: TodoStatus;
  /** Button label — "Connect" / "Enable" / "Edit" / etc. */
  actionLabel: string;
  /** Free-form callback so each todo can do the right thing —
   *  navigate to a tab, reveal a file in Finder, launch a
   *  calibrate skill, etc. Beats forcing every action into a
   *  fixed nav shape that doesn't fit (e.g. policy files have no
   *  dedicated UI editor — they need a reveal or a slash skill). */
  onAction: () => void;
}

/** Switch to a tab + optionally a Settings sub-section. */
function navigateTo(payload: {
  tab?: string;
  settingsSection?: string;
}): void {
  window.dispatchEvent(
    new CustomEvent('jarvis:navigate', { detail: payload }),
  );
}

/** Launch a calibrate-style skill (e.g. triage-calibrate,
 *  inbox-calibrate) so the user gets a guided convo to refine the
 *  underlying markdown file. Lands in AI Agent with the running task. */
function launchCalibrate(skillId: string, prompt: string): void {
  window.jarvis
    .launchTask({ skillId, prompt, origin: 'palette' })
    .then(() => {
      // Navigate to AI Agent so the user can see the conversation
      // unfold + reply to the skill's questions.
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'ai-agent' } }),
      );
    })
    .catch((err) =>
      console.error('[building-home] launchCalibrate failed', err),
    );
}

export function BuildingHome() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [integrations, setIntegrations] = useState<ConnectorSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [workingHours, setWorkingHours] = useState<WorkingHoursPrefs | null>(
    null,
  );
  const [triagePolicyCustom, setTriagePolicyCustom] = useState<boolean | null>(
    null,
  );
  const [inboxPrioritiesCustom, setInboxPrioritiesCustom] = useState<
    boolean | null
  >(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        const [s, ints, wfRes, wh] = await Promise.all([
          window.jarvis.getStatus(),
          window.jarvis.listIntegrations(),
          window.jarvis.listWorkflows(),
          window.jarvis.workingHoursRead(),
        ]);
        setStatus(s);
        setIntegrations(ints);
        setWorkflows(wfRes.workflows);
        setWorkingHours(wh);
      } catch {
        // benign — leave UI empty if reads fail
      }
    };
    void refresh();
    const offInts = window.jarvis.onIntegrationsChanged(refresh);
    const offWf = window.jarvis.onWorkflowsChanged(() => void refresh());
    return () => {
      offInts();
      offWf();
    };
  }, []);

  useEffect(() => {
    void window.jarvis
      .readJarvisFile('triage-policy.md')
      .then((content) => setTriagePolicyCustom(isPolicyCustomized(content)))
      .catch(() => setTriagePolicyCustom(false));
    void window.jarvis
      .readJarvisFile('inbox-priorities.md')
      .then((content) =>
        setInboxPrioritiesCustom(isInboxPrioritiesCustomized(content)),
      )
      .catch(() => setInboxPrioritiesCustom(false));
  }, []);

  const todos: TodoItem[] = useMemo(() => {
    const list: TodoItem[] = [];

    // Auth — pending if no token of the active mode.
    // Settings → General has the auth-mode panel + Anthropic key
    // entry; that's the right landing for "sign in".
    const authDone =
      (status?.authMode === 'subscription' && status?.hasSubscriptionToken) ||
      (status?.authMode === 'api-key' && status?.hasApiKey);
    if (status && !authDone) {
      list.push({
        id: 'auth',
        title: 'Sign in to Claude',
        description:
          'Subscription mode (recommended — billed via Claude.ai plan) or an Anthropic API key.',
        status: 'pending',
        actionLabel: 'Sign in',
        onAction: () =>
          navigateTo({ tab: 'settings', settingsSection: 'general' }),
      });
    }

    // Integrations — pending per major connector that isn't connected
    const importantConnectors = [
      { id: 'google', label: 'Google (Gmail + Calendar)' },
      { id: 'slack', label: 'Slack' },
      { id: 'github', label: 'GitHub' },
    ];
    const disconnected = importantConnectors.filter((c) => {
      const conn = integrations.find((i) => i.id === c.id);
      return (conn?.accounts ?? []).length === 0;
    });
    for (const c of disconnected) {
      list.push({
        id: `connector-${c.id}`,
        title: `Connect ${c.label}`,
        description: connectorWhy(c.id),
        status: 'pending',
        actionLabel: 'Connect',
        onAction: () =>
          navigateTo({ tab: 'settings', settingsSection: 'integrations' }),
      });
    }

    // Autopilots — partial if installed but none enabled
    const autopilots = workflows.filter((w) => w.trigger.kind === 'autopilot');
    const enabledAutopilots = autopilots.filter((w) => w.enabled);
    if (autopilots.length > 0 && enabledAutopilots.length === 0) {
      list.push({
        id: 'autopilot',
        title: 'Enable a triage workflow',
        description: `${autopilots.length} autopilots installed (Gmail / Slack / PR comments / PR review) but none enabled. Flip one on under Workflows, then set the tray to Autopilot mode to let it fire.`,
        status: 'partial',
        actionLabel: 'Enable',
        onAction: () => navigateTo({ tab: 'workflows' }),
      });
    }

    // Triage policy — partial if untouched default.
    // ~/.jarvis/triage-policy.md has no dedicated Settings editor;
    // launching the triage-calibrate skill gives the user a guided
    // conversation that edits the file for them.
    if (triagePolicyCustom === false) {
      list.push({
        id: 'triage-policy',
        title: 'Customize triage policy',
        description:
          'Tell the triage skills who you draft for, what to archive, and your tone. Default placeholder — refine before running the autopilots.',
        status: 'partial',
        actionLabel: 'Refine',
        onAction: () =>
          launchCalibrate(
            'triage-calibrate',
            'Walk me through tuning my triage policy.',
          ),
      });
    }

    // Inbox priorities — partial if untouched default.
    // Same pattern: no UI editor; inbox-calibrate skill drives it.
    if (inboxPrioritiesCustom === false) {
      list.push({
        id: 'inbox-priorities',
        title: 'Customize inbox priorities',
        description:
          'Tell the smart-inbox curator who matters and what to mute. Default placeholder.',
        status: 'partial',
        actionLabel: 'Refine',
        onAction: () =>
          launchCalibrate(
            'inbox-calibrate',
            'Walk me through tuning my inbox priorities.',
          ),
      });
    }

    // Working hours — pure info, only surface if completely default.
    // Settings → PREFERENCES (not General) hosts the WorkingHoursPanel
    // alongside the preferences.md editor.
    const defaultHours = { startHour: 9, endHour: 18, daysOfWeek: '1-5' };
    if (
      workingHours &&
      workingHours.startHour === defaultHours.startHour &&
      workingHours.endHour === defaultHours.endHour &&
      workingHours.daysOfWeek === defaultHours.daysOfWeek
    ) {
      list.push({
        id: 'working-hours',
        title: 'Set your working hours',
        description:
          'Currently 09:00–18:00 Mon–Fri (the default). Every inbox-sync workflow uses this to fire only when you might look.',
        status: 'partial',
        actionLabel: 'Adjust',
        onAction: () =>
          navigateTo({ tab: 'settings', settingsSection: 'preferences' }),
      });
    }

    return list;
  }, [
    status,
    integrations,
    workflows,
    triagePolicyCustom,
    inboxPrioritiesCustom,
    workingHours,
  ]);

  const allDone = todos.length === 0;

  return (
    <div className="building-home">
      <header className="building-home__hero">
        <h1 className="building-home__title">Building</h1>
        <p className="building-home__subtitle">
          Configure how Jarvis works. Connect accounts, tune workflows, manage
          skills. The list below surfaces anything that's still off.
        </p>
      </header>

      <SystemPulse />

      <section className="building-home__todos">
        <header className="building-home__todos-head">
          <h2 className="building-home__section-title">Needs your attention</h2>
          {allDone ? (
            <span className="building-home__todos-empty-tag">All clear</span>
          ) : (
            <span className="building-home__todos-count">
              {todos.length} item{todos.length === 1 ? '' : 's'}
            </span>
          )}
        </header>
        {allDone ? (
          <div className="building-home__todos-empty">
            <p style={{ margin: 0 }}>
              Everything looks set up. Tune workflows or write new skills from
              the sidebar when you're ready.
            </p>
          </div>
        ) : (
          <ul className="building-home__todos-list">
            {todos.map((t) => (
              <li
                key={t.id}
                className={`building-home__todo building-home__todo--${t.status}`}
              >
                <span
                  className={`building-home__todo-dot building-home__todo-dot--${t.status}`}
                  aria-hidden
                />
                <div className="building-home__todo-body">
                  <div className="building-home__todo-title">{t.title}</div>
                  <div className="building-home__todo-description">
                    {t.description}
                  </div>
                </div>
                <button
                  type="button"
                  className={`building-home__todo-action building-home__todo-action--${t.status}`}
                  onClick={() => t.onAction()}
                >
                  {t.actionLabel}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function connectorWhy(id: string): string {
  switch (id) {
    case 'google':
      return 'Gmail triage drafts replies; Calendar feeds the agenda + availability paraphrasing.';
    case 'slack':
      return 'Slack DM autopilot drafts ack replies; the Inbox surfaces unread DMs and mentions.';
    case 'github':
      return 'PR comment + review autopilots use the `gh` CLI; the connector unlocks managed token rotation.';
    default:
      return '';
  }
}

/**
 * Heuristic: the seeded triage-policy.md ships with placeholder
 * bullets like `(e.g. "alice@acme.com — boss, always draft")` and
 * common archive patterns. Customized = any added non-placeholder
 * bullet OR a "Running notes" timestamp block (`### YYYY-MM-DD`).
 */
function isPolicyCustomized(content: string): boolean {
  if (!content) return false;
  if (/^### \d{4}-\d{2}-\d{2}/m.test(content)) return true;
  const seededBullets = new Set([
    '- noreply@*',
    '- no-reply@*',
    '- newsletter@*',
    '- marketing@*',
    '- *@notifications.atlassian.com',
    '- (add your own patterns)',
    '- interview',
    '- offer',
    '- contract',
    '- intro / introduction',
    '- urgent / asap',
    '- receipt',
    '- order confirmation',
    '- password reset',
  ]);
  return content.split('\n').some((line) => {
    const t = line.trim();
    if (!t.startsWith('- ')) return false;
    if (t.startsWith('- (')) return false;
    if (seededBullets.has(t)) return false;
    if (t.startsWith('- (GitHub')) return false;
    if (
      t.startsWith('- Tone:') ||
      t.startsWith('- Signature:') ||
      t.startsWith('- Working hours:') ||
      t.startsWith('- Best for short syncs:') ||
      t.startsWith('- Long blocks:')
    ) {
      return false;
    }
    return true;
  });
}

function isInboxPrioritiesCustomized(content: string): boolean {
  if (!content) return false;
  if (/^### \d{4}-\d{2}-\d{2}/m.test(content)) return true;
  return content.split('\n').some((line) => {
    const t = line.trim();
    if (!t.startsWith('- ')) return false;
    if (t.startsWith('- (')) return false;
    return true;
  });
}
