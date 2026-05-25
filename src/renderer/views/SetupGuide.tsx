import { useEffect, useMemo, useState } from 'react';

import type {
  AppStatus,
  ConnectorSummary,
  WorkflowDef,
  WorkingHoursPrefs,
} from '../../shared/types';

/**
 * SetupGuide — the landing surface for Jarvis "Setup" mode. A single
 * checklist of what needs configuring for Jarvis to do real work:
 * sign-in, OAuth integrations, policy files, autopilot workflows,
 * working-hours preference. Each row shows a live status (done /
 * partial / pending) and a one-click action that lands the user in
 * the deep-config surface (Settings → Integrations, Workflows tab,
 * etc.).
 *
 * Distinct from the first-run `Setup.tsx` wizard — that one runs
 * pre-auth, before the shell mounts. SetupGuide runs inside the
 * shell whenever the user flips the header toggle to "Setup".
 */

type ItemStatus = 'done' | 'partial' | 'pending';

interface SetupItem {
  id: string;
  category: 'auth' | 'integration' | 'policy' | 'workflows' | 'preferences';
  title: string;
  description: string;
  status: ItemStatus;
  hint?: string;
  actionLabel: string;
  onAction: () => void;
}

interface Props {
  onNavigate: (target: {
    tab?: string;
    moduleId?: string;
    settingsSection?: string;
  }) => void;
}

export function SetupGuide({ onNavigate }: Props) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [integrations, setIntegrations] = useState<ConnectorSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [triagePolicyCustom, setTriagePolicyCustom] = useState<boolean | null>(
    null,
  );
  const [inboxPrioritiesCustom, setInboxPrioritiesCustom] = useState<
    boolean | null
  >(null);
  const [workingHours, setWorkingHours] = useState<WorkingHoursPrefs | null>(
    null,
  );

  useEffect(() => {
    const refresh = async () => {
      try {
        const [s, ints, wf, wh] = await Promise.all([
          window.jarvis.getStatus(),
          window.jarvis.listIntegrations(),
          window.jarvis.listWorkflows().then((r) => r.workflows),
          window.jarvis.workingHoursRead(),
        ]);
        setStatus(s);
        setIntegrations(ints);
        setWorkflows(wf);
        setWorkingHours(wh);
      } catch (err) {
        console.error('[setup-guide] refresh failed', err);
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

  // Triage policy + inbox priorities — read once, decide if user
  // customized (heuristic: file has a "Running notes" timestamped
  // calibration block, or any non-placeholder bullet).
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

  const items: SetupItem[] = useMemo(() => {
    const list: SetupItem[] = [];

    // Auth
    const authDone =
      (status?.authMode === 'subscription' && status?.hasSubscriptionToken) ||
      (status?.authMode === 'api-key' && status?.hasApiKey);
    list.push({
      id: 'auth',
      category: 'auth',
      title: 'Sign in to Claude',
      description:
        'Subscription mode (recommended — billed via your Claude.ai plan) or API key (billed via the Anthropic API).',
      status: authDone ? 'done' : 'pending',
      hint: authDone
        ? `Connected via ${status?.authMode === 'subscription' ? 'subscription' : 'API key'}`
        : 'Not signed in',
      actionLabel: authDone ? 'Switch method' : 'Sign in',
      onAction: () => onNavigate({ tab: 'settings', settingsSection: 'general' }),
    });

    // Integrations
    const importantConnectors = ['google', 'slack', 'github'];
    for (const id of importantConnectors) {
      const conn = integrations.find((c) => c.id === id);
      const accounts = conn?.accounts ?? [];
      const isDone = accounts.length > 0;
      list.push({
        id: `connector-${id}`,
        category: 'integration',
        title: connectorLabel(id),
        description: connectorDescription(id),
        status: isDone ? 'done' : 'pending',
        hint: isDone
          ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} connected`
          : 'Not connected',
        actionLabel: isDone ? 'Manage' : 'Connect',
        onAction: () =>
          onNavigate({ tab: 'settings', settingsSection: 'integrations' }),
      });
    }

    // Triage policy
    list.push({
      id: 'triage-policy',
      category: 'policy',
      title: 'Triage policy',
      description:
        'Who to draft for, what to archive, what tone to use. Read by every triage skill (Gmail, Slack, PR comments) on every run.',
      status:
        triagePolicyCustom == null
          ? 'pending'
          : triagePolicyCustom
            ? 'done'
            : 'partial',
      hint:
        triagePolicyCustom == null
          ? '~/.jarvis/triage-policy.md — checking…'
          : triagePolicyCustom
            ? 'Customized'
            : 'Default placeholder — edit before running triage',
      actionLabel: 'Edit',
      onAction: () =>
        onNavigate({ tab: 'settings', settingsSection: 'preferences' }),
    });

    // Inbox priorities
    list.push({
      id: 'inbox-priorities',
      category: 'policy',
      title: 'Inbox priorities',
      description:
        'What the smart-inbox curator boosts vs mutes. Edit via the file or refine by `/inbox-calibrate`.',
      status:
        inboxPrioritiesCustom == null
          ? 'pending'
          : inboxPrioritiesCustom
            ? 'done'
            : 'partial',
      hint:
        inboxPrioritiesCustom == null
          ? '~/.jarvis/inbox-priorities.md — checking…'
          : inboxPrioritiesCustom
            ? 'Customized'
            : 'Default placeholder',
      actionLabel: 'Edit',
      onAction: () =>
        onNavigate({ tab: 'settings', settingsSection: 'preferences' }),
    });

    // Autopilot workflows
    const autopilotWorkflows = workflows.filter(
      (w) => w.trigger.kind === 'autopilot',
    );
    const enabledAutopilots = autopilotWorkflows.filter((w) => w.enabled);
    list.push({
      id: 'autopilot',
      category: 'workflows',
      title: 'Enable triage workflows',
      description:
        'Gmail / Slack DM / PR-comments / PR-review triage. All default off — enable the ones you want, then flip Jarvis to Autopilot in the tray.',
      status:
        enabledAutopilots.length > 0
          ? 'done'
          : autopilotWorkflows.length > 0
            ? 'partial'
            : 'pending',
      hint:
        autopilotWorkflows.length === 0
          ? 'No autopilot workflows installed yet'
          : `${enabledAutopilots.length} of ${autopilotWorkflows.length} enabled`,
      actionLabel: 'Configure',
      onAction: () => onNavigate({ tab: 'workflows' }),
    });

    // Working hours
    const defaultHours = { startHour: 9, endHour: 18, daysOfWeek: '1-5' };
    const hoursCustomized =
      workingHours != null &&
      (workingHours.startHour !== defaultHours.startHour ||
        workingHours.endHour !== defaultHours.endHour ||
        workingHours.daysOfWeek !== defaultHours.daysOfWeek);
    list.push({
      id: 'working-hours',
      category: 'preferences',
      title: 'Working hours',
      description:
        'Drives the `{businessHours}` cron token — every inbox-sync workflow uses it to fire only when you might look.',
      status: hoursCustomized ? 'done' : 'partial',
      hint:
        workingHours == null
          ? 'Loading…'
          : `${formatHours(workingHours.startHour)}–${formatHours(workingHours.endHour)} · ${formatDays(workingHours.daysOfWeek)}`,
      actionLabel: 'Adjust',
      onAction: () =>
        onNavigate({ tab: 'settings', settingsSection: 'general' }),
    });

    return list;
  }, [
    status,
    integrations,
    workflows,
    triagePolicyCustom,
    inboxPrioritiesCustom,
    workingHours,
    onNavigate,
  ]);

  const stats = useMemo(() => {
    const done = items.filter((i) => i.status === 'done').length;
    const partial = items.filter((i) => i.status === 'partial').length;
    const pending = items.filter((i) => i.status === 'pending').length;
    return { done, partial, pending, total: items.length };
  }, [items]);

  return (
    <div className="setup-guide">
      <header className="setup-guide__hero">
        <h1 className="setup-guide__title">Setup</h1>
        <p className="setup-guide__subtitle">
          Connect your accounts, tune the triage policy, and enable the
          autopilots you want. Switch to <strong>Working</strong> in the
          header once everything looks good.
        </p>
        <div className="setup-guide__progress">
          <div className="setup-guide__progress-bar">
            <div
              className="setup-guide__progress-fill"
              style={{
                width: `${(stats.done / Math.max(1, stats.total)) * 100}%`,
              }}
            />
          </div>
          <div className="setup-guide__progress-label">
            <span className="setup-guide__stat setup-guide__stat--done">
              {stats.done} done
            </span>
            {stats.partial > 0 && (
              <span className="setup-guide__stat setup-guide__stat--partial">
                {stats.partial} partial
              </span>
            )}
            {stats.pending > 0 && (
              <span className="setup-guide__stat setup-guide__stat--pending">
                {stats.pending} pending
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="setup-guide__groups">
        {(['auth', 'integration', 'policy', 'workflows', 'preferences'] as const).map(
          (cat) => {
            const groupItems = items.filter((i) => i.category === cat);
            if (groupItems.length === 0) return null;
            return (
              <section key={cat} className="setup-group">
                <h2 className="setup-group__title">{categoryLabel(cat)}</h2>
                <div className="setup-group__items">
                  {groupItems.map((item) => (
                    <SetupCard key={item.id} item={item} />
                  ))}
                </div>
              </section>
            );
          },
        )}
      </div>
    </div>
  );
}

function SetupCard({ item }: { item: SetupItem }) {
  const statusGlyph = ({ done: '●', partial: '◐', pending: '○' } as const)[
    item.status
  ];
  return (
    <article className={`setup-card setup-card--${item.status}`}>
      <div className="setup-card__head">
        <span
          className={`setup-card__status setup-card__status--${item.status}`}
          aria-hidden
        >
          {statusGlyph}
        </span>
        <h3 className="setup-card__title">{item.title}</h3>
      </div>
      <p className="setup-card__description">{item.description}</p>
      <div className="setup-card__foot">
        <span className="setup-card__hint">{item.hint ?? ''}</span>
        <button
          type="button"
          className={`setup-card__action setup-card__action--${item.status}`}
          onClick={item.onAction}
        >
          {item.actionLabel}
        </button>
      </div>
    </article>
  );
}

function categoryLabel(c: SetupItem['category']): string {
  switch (c) {
    case 'auth':
      return 'Authentication';
    case 'integration':
      return 'Connected accounts';
    case 'policy':
      return 'Policy files';
    case 'workflows':
      return 'Autopilot';
    case 'preferences':
      return 'Preferences';
  }
}

function connectorLabel(id: string): string {
  switch (id) {
    case 'google':
      return 'Google (Gmail + Calendar)';
    case 'slack':
      return 'Slack';
    case 'github':
      return 'GitHub';
    default:
      return id;
  }
}

function connectorDescription(id: string): string {
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

function formatHours(h: number): string {
  return `${h.toString().padStart(2, '0')}:00`;
}

function formatDays(daysOfWeek: string): string {
  if (daysOfWeek === '1-5') return 'Mon–Fri';
  if (daysOfWeek === '0-6' || daysOfWeek === '*') return 'every day';
  return daysOfWeek;
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
    if (t.startsWith('- (')) return false; // "(e.g. …)" placeholders
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
