import { useEffect, useMemo, useState } from 'react';

import type {
  ActivityEvent,
  ProjectDef,
  TaskSummary,
} from '../../shared/types';

import { entityInActiveWorkspace } from './workspaces/workspaceFilters';
import { useWorkspace } from './workspaces/useWorkspace';

/**
 * Activity tab — Phase 2.
 *
 * Two data streams merged into one time-sorted feed:
 *   1. `/send` tasks (filtered from TaskRegistry; same as Phase 1 — the
 *      conversational rows with channel chip + status badge).
 *   2. ActivityStore events (note created, meeting started, MCP
 *      disabled, inbox source cleared, etc.).
 *
 * Click a /send row → opens its transcript in the Observatory. Click
 * an event row → does whatever the `kind` warrants (open file, jump
 * to a tab) via small per-kind handlers below. Phase 3 would add a
 * filter bar across the top; for now everything is one stream.
 */

type BrowserVisit = { url: string; title: string; at: number };

type Row =
  | { kind: 'send'; ts: number; task: TaskSummary }
  | { kind: 'event'; ts: number; event: ActivityEvent }
  | { kind: 'browser'; ts: number; visit: BrowserVisit };

/** Filter chip selections — null means "show everything." */
type CategoryFilter =
  | null
  | 'send'
  | 'note'
  | 'meeting'
  | 'integration'
  | 'inbox'
  | 'reminder'
  | 'workflow'
  | 'dedupe'
  | 'browser';

const FILTER_KEY = 'jarvis.activity.filter';

export function Activity() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [projects, setProjects] = useState<ProjectDef[]>([]);
  const workspace = useWorkspace();
  useEffect(() => {
    void window.jarvis.listProjects().then(setProjects);
    return window.jarvis.onProjectsChanged(setProjects);
  }, []);
  // Active project from the Shell's scope picker. When set, the feed
  // restricts to task-derived rows whose projectName matches and
  // event rows whose detail.projectName matches. Event rows without
  // a project field stay visible (they're global side-effects like
  // "API key changed").
  const [activeProject, setActiveProject] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem('jarvis.activeProject') || null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const onScopeChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { project?: string | null };
      setActiveProject(detail?.project ?? null);
    };
    window.addEventListener('jarvis:active-project-changed', onScopeChange);
    return () =>
      window.removeEventListener('jarvis:active-project-changed', onScopeChange);
  }, []);

  const [filter, setFilterRaw] = useState<CategoryFilter>(() => {
    try {
      const stored = window.localStorage.getItem(FILTER_KEY);
      if (stored === null) return null;
      const valid: CategoryFilter[] = [
        'send', 'note', 'meeting', 'integration', 'inbox', 'reminder', 'workflow', 'dedupe', 'browser',
      ];
      return (valid as string[]).includes(stored) ? (stored as CategoryFilter) : null;
    } catch {
      return null;
    }
  });
  const setFilter = (f: CategoryFilter) => {
    setFilterRaw(f);
    try {
      if (f === null) window.localStorage.removeItem(FILTER_KEY);
      else window.localStorage.setItem(FILTER_KEY, f);
    } catch {
      // private mode etc — non-fatal
    }
  };

  useEffect(() => {
    void window.jarvis.listTasks().then(setTasks);
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === summary.id);
        if (i === -1) return [summary, ...prev];
        const next = prev.slice();
        next[i] = summary;
        return next;
      });
    });
    const offRemoved = window.jarvis.onTaskRemoved((taskId) => {
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    });
    return () => {
      offStatus();
      offRemoved();
    };
  }, []);

  useEffect(() => {
    void window.jarvis.listActivity(200).then(setEvents);
    const off = window.jarvis.onActivityChanged((event) => {
      setEvents((prev) => [event, ...prev]);
    });
    return off;
  }, []);

  // RAM-only browser ring buffer from the Chrome extension. Lives
  // only as long as the app process — quitting Jarvis wipes it.
  // Re-fetched on each `browserActivityChanged` so refreshed
  // heartbeat timestamps surface in the feed.
  const [browserVisits, setBrowserVisits] = useState<BrowserVisit[]>([]);
  useEffect(() => {
    void window.jarvis.listBrowserActivity().then(setBrowserVisits);
    const off = window.jarvis.onBrowserActivityChanged(() => {
      void window.jarvis.listBrowserActivity().then(setBrowserVisits);
    });
    return off;
  }, []);

  const rows = useMemo<Row[]>(() => {
    const sendRows: Row[] = tasks
      .filter((t) => t.skillId === 'send')
      .map((t) => ({ kind: 'send', ts: t.startedAt, task: t }));
    const eventRows: Row[] = events.map((e) => ({
      kind: 'event',
      ts: e.ts,
      event: e,
    }));
    const browserRows: Row[] = browserVisits.map((v) => ({
      kind: 'browser',
      ts: v.at,
      visit: v,
    }));
    let merged = [...sendRows, ...eventRows, ...browserRows].sort(
      (a, b) => b.ts - a.ts,
    );
    if (filter !== null) {
      merged = merged.filter((r) => {
        if (r.kind === 'send') return filter === 'send';
        if (r.kind === 'browser') return filter === 'browser';
        const meta = EVENT_KIND_META[r.event.kind];
        return meta?.category === filter;
      });
    }
    // Workspace filter — runs BEFORE the project-scope filter so the
    // user only ever sees rows tied to projects in the current
    // workspace. Rows without any project tag (auth changes, API key
    // updates, browser visits) stay visible — those are global audit
    // trail.
    if (workspace.id) {
      merged = merged.filter((r) => {
        if (r.kind === 'browser') return true;
        if (r.kind === 'send') {
          return entityInActiveWorkspace({
            projectName: r.task.projectName ?? null,
            projects,
            activeWorkspaceId: workspace.id,
          });
        }
        const detail = r.event.detail as
          | { projectName?: unknown; project?: unknown }
          | null
          | undefined;
        const evtProject =
          detail && typeof detail === 'object'
            ? typeof detail.projectName === 'string'
              ? detail.projectName
              : typeof detail.project === 'string'
                ? detail.project
                : null
            : null;
        return entityInActiveWorkspace({
          projectName: evtProject,
          projects,
          activeWorkspaceId: workspace.id,
        });
      });
    }
    // Scope filter — task rows respect projectName exactly; event rows
    // either carry a project in detail.projectName / detail.project,
    // or are global (kept). The "always-show-global" rule mirrors the
    // Now view so the user doesn't lose audit trail for non-scoped
    // actions (auth changes, API key updates, etc.) while focused.
    if (activeProject) {
      merged = merged.filter((r) => {
        if (r.kind === 'send') {
          return !r.task.projectName || r.task.projectName === activeProject;
        }
        // Browser visits don't carry a project — always show (global).
        if (r.kind === 'browser') return true;
        const detail = r.event.detail as
          | { projectName?: unknown; project?: unknown }
          | null
          | undefined;
        if (!detail || typeof detail !== 'object') return true;
        const evtProject =
          typeof detail.projectName === 'string'
            ? detail.projectName
            : typeof detail.project === 'string'
            ? detail.project
            : null;
        return !evtProject || evtProject === activeProject;
      });
    }
    return merged.slice(0, 200);
  }, [tasks, events, browserVisits, filter, activeProject, workspace.id, projects]);

  // Counts per category — surfaces in the chip labels so the user
  // sees "Reminders 3" instead of just "Reminders." Helps decide what
  // to filter to. Respects scope so the chip counts reflect what's
  // actually visible after the project filter.
  const counts = useMemo(() => {
    const out: Record<string, number> = {
      send: 0,
      note: 0,
      meeting: 0,
      integration: 0,
      inbox: 0,
      reminder: 0,
      workflow: 0,
      dedupe: 0,
      browser: 0,
    };
    for (const t of tasks) {
      if (t.skillId !== 'send') continue;
      if (activeProject && t.projectName && t.projectName !== activeProject) continue;
      out.send!++;
    }
    for (const e of events) {
      const cat = EVENT_KIND_META[e.kind]?.category;
      if (!cat || cat === 'other') continue;
      if (activeProject) {
        const detail = e.detail as
          | { projectName?: unknown; project?: unknown }
          | null
          | undefined;
        if (detail && typeof detail === 'object') {
          const evtProject =
            typeof detail.projectName === 'string'
              ? detail.projectName
              : typeof detail.project === 'string'
              ? detail.project
              : null;
          if (evtProject && evtProject !== activeProject) continue;
        }
      }
      out[cat] = (out[cat] ?? 0) + 1;
    }
    out.browser = browserVisits.length;
    return out;
  }, [tasks, events, browserVisits, activeProject]);

  return (
    <section className="activity">
      <header className="activity__header">
        <div>
          <h2>
            ACTIVITY
            {activeProject && (
              <span
                className="now__scope"
                title={`Filtering to project: ${activeProject}. Clear scope in the top-right to see everything.`}
              >
                scope: {activeProject}
              </span>
            )}
          </h2>
          <p>
            Things you've done through Jarvis — <code>/send</code> messages,
            meetings, notes, integration toggles, inbox cleanups. Click a
            row to jump to its surface.
          </p>
        </div>
        <div className="activity__count">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </div>
      </header>

      <CategoryFilterStrip
        active={filter}
        counts={counts}
        onChange={setFilter}
      />

      {rows.length === 0 ? (
        <div className="activity__empty">
          Nothing here yet. As you use Jarvis (drafting messages,
          recording meetings, toggling integrations) this feed fills up.
        </div>
      ) : (
        <div className="activity__groups">
          {groupByDay(rows).map((group) => (
            <section key={group.label} className="activity__group">
              <h3 className="activity__group-label">{group.label}</h3>
              <ul className="activity__list">
                {group.rows.map((row) =>
                  row.kind === 'send' ? (
                    <SendRow key={`send-${row.task.id}`} task={row.task} />
                  ) : row.kind === 'browser' ? (
                    <BrowserRow
                      key={`browser-${row.visit.url}-${row.visit.at}`}
                      visit={row.visit}
                    />
                  ) : (
                    <EventRow key={`event-${row.event.id}`} event={row.event} />
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Bucket rows into Today / Yesterday / This week / Earlier. Same
 * spirit as the Dashboard's CalendarTimeline grouping; rendered here
 * as `<h3>` separators between groups.
 */
function groupByDay(rows: Row[]): Array<{ label: string; rows: Row[] }> {
  if (rows.length === 0) return [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const weekStart = today - 7 * 24 * 60 * 60 * 1000;
  const buckets: Record<string, Row[]> = {};
  for (const row of rows) {
    let key: string;
    if (row.ts >= today) key = 'Today';
    else if (row.ts >= yesterday) key = 'Yesterday';
    else if (row.ts >= weekStart) key = 'This week';
    else key = 'Earlier';
    if (!buckets[key]) buckets[key] = [];
    buckets[key]!.push(row);
  }
  const order = ['Today', 'Yesterday', 'This week', 'Earlier'];
  return order
    .filter((k) => buckets[k])
    .map((label) => ({ label, rows: buckets[label]! }));
}

function openObservatoryTask(id: string): void {
  // Peek into the in-window SessionSidebar — keeps the user on the
  // Activity tab so they can drill into the transcript and come back
  // without losing their place in the feed. The sidebar has the
  // inline reply box for running tasks; Observatory is still reachable
  // via the "Open full view" button inside the sidebar footer.
  window.dispatchEvent(
    new CustomEvent('jarvis:open-session', { detail: { taskId: id } }),
  );
}

function SendRow({ task }: { task: TaskSummary }) {
  const channel = inferChannel(task.inputPreview);
  return (
    <li>
      <button
        className="activity__row"
        onClick={() => openObservatoryTask(task.id)}
        title="Open transcript"
      >
        <StatusBadge status={statusKind(task)} />
        {channel && <ChannelChip channel={channel} />}
        <span className="activity__preview" title={task.inputPreview}>
          {task.inputPreview || '(empty prompt)'}
        </span>
        {task.pooled && (
          <span
            className="activity__pooled"
            title="This task resumed a pooled SDK session — skipped the cold start"
          >
            ↪
          </span>
        )}
        {task.costUsd > 0 && (
          <span
            className="activity__cost"
            title={`Cost: $${task.costUsd.toFixed(4)}`}
          >
            ${task.costUsd >= 0.01 ? task.costUsd.toFixed(2) : task.costUsd.toFixed(4)}
          </span>
        )}
        <span className="activity__time">{formatRel(task.startedAt)}</span>
      </button>
    </li>
  );
}

/**
 * Per-kind handler maps an ActivityEvent.kind to a navigation action
 * + a short "category" label that drives the badge color.
 */
const EVENT_KIND_META: Record<
  string,
  {
    category:
      | 'note'
      | 'meeting'
      | 'integration'
      | 'inbox'
      | 'reminder'
      | 'workflow'
      | 'dedupe'
      | 'other';
    label: string;
  }
> = {
  'note.created': { category: 'note', label: 'note' },
  'note.archived': { category: 'note', label: 'note · archive' },
  'note.restored': { category: 'note', label: 'note · restore' },
  'note.deleted': { category: 'note', label: 'note · delete' },
  'meeting.started': { category: 'meeting', label: 'meeting' },
  'meeting.finished': { category: 'meeting', label: 'meeting' },
  'mcp.enabled': { category: 'integration', label: 'integration · on' },
  'mcp.disabled': { category: 'integration', label: 'integration · off' },
  'mcp.removed': { category: 'integration', label: 'integration · remove' },
  'mcp.added': { category: 'integration', label: 'integration · add' },
  'mcp.updated': { category: 'integration', label: 'integration · update' },
  'mcp.file-replaced': { category: 'integration', label: 'integration · file replace' },
  'preferences.edited': { category: 'integration', label: 'preferences · edit' },
  'notification-prefs.changed': { category: 'integration', label: 'prefs · notify' },
  'inbox-prefs.changed': { category: 'inbox', label: 'inbox · prefs' },
  'auth.api-key-set': { category: 'integration', label: 'auth · api key set' },
  'auth.api-key-cleared': { category: 'integration', label: 'auth · api key cleared' },
  'auth.subscription-token-set': { category: 'integration', label: 'auth · subscription set' },
  'auth.subscription-token-cleared': { category: 'integration', label: 'auth · subscription cleared' },
  'auth.mode-changed': { category: 'integration', label: 'auth · mode' },
  'project.created': { category: 'integration', label: 'project · created' },
  'project.updated': { category: 'integration', label: 'project · updated' },
  'project.deleted': { category: 'integration', label: 'project · deleted' },
  'project.inbox-scan-toggled': { category: 'integration', label: 'project · inbox scan' },
  'inbox.cleared': { category: 'inbox', label: 'inbox · clear' },
  'inbox.dismissed': { category: 'inbox', label: 'inbox · dismiss' },
  'inbox.restored': { category: 'inbox', label: 'inbox · restore' },
  'reminder.created': { category: 'reminder', label: 'reminder' },
  'reminder.scheduled': { category: 'reminder', label: 'reminder · scheduled' },
  'reminder.cancelled': { category: 'reminder', label: 'reminder · cancel' },
  'reminder.fired': { category: 'reminder', label: 'reminder · fired' },
  'reminder.done': { category: 'reminder', label: 'reminder · done' },
  'dedupe.scanned': { category: 'dedupe', label: 'dedupe · scan' },
  'module.enabled': { category: 'integration', label: 'module · on' },
  'module.disabled': { category: 'integration', label: 'module · off' },
  'module.settings-changed': { category: 'integration', label: 'module · settings' },
  'routine.auto-seeded': { category: 'integration', label: 'routine · auto-seeded' },
  'routine.created': { category: 'integration', label: 'routine · created' },
  'routine.updated': { category: 'integration', label: 'routine · updated' },
  'routine.deleted': { category: 'integration', label: 'routine · deleted' },
  'routine.ran-manually': { category: 'integration', label: 'routine · run now' },
  'skill.created': { category: 'integration', label: 'skill · created' },
  'skill.edited': { category: 'integration', label: 'skill · edited' },
  'skill.deleted': { category: 'integration', label: 'skill · deleted' },
  'jarvis-file.written': { category: 'integration', label: 'file · edited' },
  // Module-side action logs added in the activity-coverage sweep.
  'shell.ran': { category: 'other', label: 'shell · run' },
  'send.dispatched': { category: 'other', label: 'send' },
  'status.requested': { category: 'other', label: 'status' },
  'pr.review-queue': { category: 'other', label: 'pr · review queue' },
  'pr.address-comments': { category: 'other', label: 'pr · address comments' },
  'skill-suggester.analyzed': { category: 'integration', label: 'skill suggester · analyzed' },
  'routine.fired': { category: 'integration', label: 'routine · fired' },
  'routine.auto-disabled': { category: 'integration', label: 'routine · auto-disabled' },
  'inbox.json-migrated': { category: 'inbox', label: 'inbox · json migrated' },
  'paused.toggled': { category: 'integration', label: 'pause · toggled' },
  'afk.toggled': { category: 'integration', label: 'afk · toggled' },
  'telegram.connected': { category: 'integration', label: 'telegram · connected' },
  'telegram.connect-failed': { category: 'integration', label: 'telegram · failed' },
  'telegram.abort': { category: 'other', label: 'telegram · abort' },
  'telegram.fork': { category: 'other', label: 'telegram · new thread' },
  'telegram.voice': { category: 'other', label: 'telegram · voice' },
  'skill-suggestion.accepted': { category: 'integration', label: 'skill suggestion · accepted' },
  'skill-suggestion.dismissed': { category: 'integration', label: 'skill suggestion · dismissed' },
  'task.aborted': { category: 'other', label: 'task · aborted' },
  'reminder.snoozed': { category: 'reminder', label: 'reminder · snoozed' },
  'briefing.edited': { category: 'note', label: 'briefing · edited' },
  'briefing.generated': { category: 'integration', label: 'briefing · generated' },
  // Workflow lifecycle — created/updated/deleted via the editor +
  // terminal run statuses recorded on the runner's 'run-changed'.
  'workflow.created': { category: 'workflow', label: 'workflow · created' },
  'workflow.updated': { category: 'workflow', label: 'workflow · updated' },
  'workflow.deleted': { category: 'workflow', label: 'workflow · deleted' },
  'workflow.run': { category: 'workflow', label: 'workflow · run' },
  'workflow.ran-manually': { category: 'workflow', label: 'workflow · run now' },
  'workflow.completed': { category: 'workflow', label: 'workflow · completed' },
  'workflow.errored': { category: 'workflow', label: 'workflow · errored' },
  'workflow.aborted': { category: 'workflow', label: 'workflow · aborted' },
  'workflow.migrated': { category: 'workflow', label: 'workflow · migrated' },
  // OAuth integrations — connect / disconnect / test result / paste-creds.
  'integration.connected': { category: 'integration', label: 'integration · connected' },
  'integration.disconnected': { category: 'integration', label: 'integration · disconnected' },
  'integration.test-ok': { category: 'integration', label: 'integration · test ok' },
  'integration.test-failed': { category: 'integration', label: 'integration · test failed' },
  'integration.credentials-set': { category: 'integration', label: 'integration · creds set' },
  'integration.credentials-cleared': { category: 'integration', label: 'integration · creds cleared' },
  'integration.account-default': { category: 'integration', label: 'integration · default' },
  'integration.account-meta': { category: 'integration', label: 'integration · meta' },
  // Autopilot tri-state mode + approval flow.
  'mode.changed': { category: 'integration', label: 'mode · changed' },
  'autopilot.approved': { category: 'workflow', label: 'autopilot · approved' },
  'autopilot.rejected': { category: 'workflow', label: 'autopilot · rejected' },
  'autopilot.feedback-cleared': { category: 'workflow', label: 'autopilot · feedback cleared' },
};

function EventRow({ event }: { event: ActivityEvent }) {
  const meta = EVENT_KIND_META[event.kind] ?? {
    category: 'other' as const,
    label: event.kind,
  };
  const onClick = () => {
    // Notes / meetings → jump to the relevant module page.
    if (event.kind.startsWith('note.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', {
          detail: { tab: 'settings', moduleId: 'quick-note' },
        }),
      );
      return;
    }
    if (event.kind.startsWith('meeting.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', {
          detail: { tab: 'settings', moduleId: 'meeting-recorder' },
        }),
      );
      return;
    }
    if (event.kind.startsWith('mcp.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'settings' } }),
      );
      return;
    }
    if (event.kind.startsWith('inbox.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
      );
      return;
    }
    if (event.kind.startsWith('reminder.')) {
      // Reminders have their own page (Notes & Reminders module,
      // Reminders tab). Routing here instead of /inbox was wrong —
      // the inbox surfaces "things waiting on you," but the audit
      // trail of a fired/done reminder belongs on its own canonical
      // page where you can see history + cancel / re-fire.
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', {
          detail: {
            tab: 'settings',
            moduleId: 'reminders',
            captureTab: 'reminders',
          },
        }),
      );
      return;
    }
    if (event.kind.startsWith('dedupe.')) {
      // Dedupe suggestions land in the Inbox.
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
      );
      return;
    }
  };
  return (
    <li>
      <button className="activity__row" onClick={onClick} title={event.kind}>
        <span
          className={`activity__cat activity__cat--${meta.category}`}
          title={meta.label}
        >
          {meta.label}
        </span>
        <span className="activity__preview" title={event.label}>
          {event.label}
        </span>
        <span className="activity__time">{formatRel(event.ts)}</span>
      </button>
    </li>
  );
}

/**
 * Row for an in-memory Chrome-extension browser visit. Click opens
 * the URL in the user's default browser (same affordance the
 * browser-activity context provider implies).
 *
 * No persistence — these rows vanish when the app quits (the ring
 * buffer is RAM-only). Hostname is extracted for a compact prefix;
 * the full URL is in the title attribute for hover.
 */
function BrowserRow({ visit }: { visit: BrowserVisit }) {
  const host = safeHost(visit.url);
  const title = visit.title?.trim() || visit.url;
  const onClick = () => {
    // External link → uses the system default browser. shell.openExternal
    // is exposed by the existing jarvis API for opening artifact paths;
    // a URL string works the same.
    void window.jarvis.openExternal(visit.url);
  };
  return (
    <li>
      <button
        className="activity__row"
        onClick={onClick}
        title={visit.url}
      >
        <span
          className="activity__cat activity__cat--browser"
          title="browser visit (RAM only, wipes on quit)"
        >
          browser
        </span>
        {host && (
          <span className="activity__channel" title={host}>
            {host}
          </span>
        )}
        <span className="activity__preview" title={title}>
          {title}
        </span>
        <span className="activity__time">{formatRel(visit.at)}</span>
      </button>
    </li>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

type StatusKind = 'in-progress' | 'awaiting' | 'sent' | 'failed' | 'cancelled';

function statusKind(t: TaskSummary): StatusKind {
  if (t.status === 'errored') return 'failed';
  if (t.status === 'aborted') return 'cancelled';
  if (t.status === 'completed') return 'sent';
  if (t.awaitingInput) return 'awaiting';
  return 'in-progress';
}

const STATUS_LABEL: Record<StatusKind, string> = {
  'in-progress': 'drafting',
  awaiting: 'waiting on you',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
};

function StatusBadge({ status }: { status: StatusKind }) {
  return (
    <span
      className={`activity__status activity__status--${status}`}
      title={STATUS_LABEL[status]}
    >
      <span className="activity__status-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

type Channel = 'slack' | 'gmail' | 'imessage';

const CHANNEL_LABEL: Record<Channel, string> = {
  slack: 'Slack',
  gmail: 'Email',
  imessage: 'iMessage',
};

function ChannelChip({ channel }: { channel: Channel }) {
  return (
    <span className={`activity__channel activity__channel--${channel}`}>
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

function inferChannel(input: string): Channel | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  if (/\bslack\b|\bdm\b|\bping\b/.test(lower)) return 'slack';
  if (/\bemail\b|\bgmail\b|\bmail\b/.test(lower)) return 'gmail';
  if (/\bimessage\b|\btext\b|\bsms\b/.test(lower)) return 'imessage';
  return null;
}

function formatRel(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Filter chips above the feed. Single-select: "All" or one category.
 * Selection persists to localStorage so the filter survives a reload.
 * Chip labels carry live counts so the user can decide what to scope
 * to without skimming the rows.
 */
const FILTER_CHIPS: Array<{
  value: Exclude<CategoryFilter, null>;
  label: string;
}> = [
  { value: 'send', label: 'Sends' },
  { value: 'reminder', label: 'Reminders' },
  { value: 'note', label: 'Notes' },
  { value: 'meeting', label: 'Meetings' },
  { value: 'integration', label: 'Integrations' },
  { value: 'workflow', label: 'Workflows' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'dedupe', label: 'Dedupe' },
  { value: 'browser', label: 'Browser' },
];

function CategoryFilterStrip({
  active,
  counts,
  onChange,
}: {
  active: CategoryFilter;
  counts: Record<string, number>;
  onChange: (next: CategoryFilter) => void;
}) {
  return (
    <div className="activity__filters" role="tablist">
      <button
        className={`activity__filter${active === null ? ' activity__filter--active' : ''}`}
        onClick={() => onChange(null)}
      >
        All
      </button>
      {FILTER_CHIPS.map((c) => {
        const n = counts[c.value] ?? 0;
        if (n === 0) return null; // hide categories with no rows so the strip stays uncluttered
        return (
          <button
            key={c.value}
            className={`activity__filter activity__filter--${c.value}${
              active === c.value ? ' activity__filter--active' : ''
            }`}
            onClick={() => onChange(active === c.value ? null : c.value)}
          >
            {c.label}
            <span className="activity__filter-count">{n}</span>
          </button>
        );
      })}
    </div>
  );
}
