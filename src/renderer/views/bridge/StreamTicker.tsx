import { useEffect, useState } from 'react';

import type { ActivityEvent, ProjectDef } from '../../../shared/types';
import { useWorkspace } from '../workspaces/useWorkspace';

/**
 * StreamTicker — the bottom band of the Bridge.
 *
 * Disney-queue effect: a thin horizontal river of icons + tiny text
 * showing what Jarvis is doing in the background — workflows ticking,
 * drafts landing, browser activity, notifier events. Read-only;
 * always in motion at a slow, ambient pace. Click a chip to drill
 * into the relevant tab.
 *
 * Two streams merged:
 *   - Persistent ActivityEvents (workflow runs, notes, inbox actions)
 *   - In-memory browser visits (RAM-only ring buffer)
 *
 * Cap at 12 visible chips; older chips slide off the right.
 */

const MAX_CHIPS = 12;

interface Chip {
  id: string;
  ts: number;
  /** Symbol drawn ahead of the label. Keep to one glyph. */
  icon: string;
  /** Short one-liner. */
  label: string;
  /** Color tone for the chip border. */
  tone: 'cyan' | 'amber' | 'magenta' | 'green' | 'slate';
  /** Optional click target — fires a navigate event. */
  onClick?(): void;
}

export function StreamTicker() {
  const [chips, setChips] = useState<Chip[]>([]);
  const [projects, setProjects] = useState<ProjectDef[]>([]);
  const workspace = useWorkspace();

  // Workspace filter for activity chips: if the event detail has a
  // `project` hint that matches a project living in ANOTHER
  // workspace, drop the chip. Activity events without a project hint
  // (most workflows, browser visits, send.dispatched, etc.) pass
  // through — the ticker is "ambient" by design so under-filtering is
  // the right failure mode. When activity events grow a first-class
  // workspaceId later this filter tightens automatically.
  useEffect(() => {
    void window.jarvis.listProjects().then(setProjects);
    return window.jarvis.onProjectsChanged(setProjects);
  }, []);

  const acceptEvent = (event: ActivityEvent): boolean => {
    if (!workspace.id) return true;
    const detail = (event.detail ?? {}) as { project?: unknown };
    const projectAlias =
      typeof detail.project === 'string' && detail.project.trim()
        ? detail.project.trim().toLowerCase()
        : null;
    if (!projectAlias) return true;
    const matched = projects.find(
      (p) =>
        p.name.toLowerCase() === projectAlias ||
        p.aliases.some((a) => a.toLowerCase() === projectAlias),
    );
    if (!matched) return true;
    if (!matched.workspaceId) return true;
    return matched.workspaceId === workspace.id;
  };

  // Hydrate from the persistent activity log + browser ring buffer.
  useEffect(() => {
    void window.jarvis.listActivity(20).then((events) => {
      const seed = events
        .filter(acceptEvent)
        .map(activityToChip)
        .filter((c): c is Chip => c != null)
        .slice(0, MAX_CHIPS);
      setChips((prev) => mergeChips(seed, prev));
    });
    void window.jarvis.listBrowserActivity().then((visits) => {
      const seed = visits
        .slice(-MAX_CHIPS)
        .map(browserToChip)
        .reverse();
      setChips((prev) => mergeChips(seed, prev));
    });
    // Reset chips when workspace switches so the previous workspace's
    // chips don't linger until they age out of the MAX_CHIPS window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, projects]);

  // Live updates.
  useEffect(() => {
    const offActivity = window.jarvis.onActivityChanged((event) => {
      if (!acceptEvent(event)) return;
      const c = activityToChip(event);
      if (!c) return;
      setChips((prev) => mergeChips([c], prev));
    });
    const offBrowser = window.jarvis.onBrowserActivityChanged((visit) => {
      setChips((prev) => mergeChips([browserToChip(visit)], prev));
    });
    return () => {
      offActivity();
      offBrowser();
    };
    // acceptEvent closure depends on projects + workspace.id; re-sub
    // when either changes so live chips honour the latest scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, projects]);

  if (chips.length === 0) {
    return (
      <div className="bridge-stream bridge-stream--empty">
        <span>STREAM · idle</span>
      </div>
    );
  }

  return (
    <div className="bridge-stream" role="log" aria-label="Background activity stream">
      <span className="bridge-stream__label">STREAM</span>
      <div className="bridge-stream__rail">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`bridge-stream__chip bridge-stream__chip--${chip.tone}`}
            onClick={chip.onClick}
            disabled={!chip.onClick}
            title={`${chip.label} · ${formatRel(chip.ts)} ago`}
          >
            <span className="bridge-stream__icon">{chip.icon}</span>
            <span className="bridge-stream__text">{chip.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Newest-first merge, dedup by id, cap to MAX_CHIPS. */
function mergeChips(incoming: Chip[], prev: Chip[]): Chip[] {
  const seen = new Set<string>();
  const out: Chip[] = [];
  for (const c of incoming) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  for (const c of prev) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= MAX_CHIPS) break;
  }
  return out.slice(0, MAX_CHIPS);
}

function activityToChip(event: ActivityEvent): Chip | null {
  // Cheap iconography per kind family.
  const k = event.kind;
  if (k.startsWith('workflow.')) {
    return {
      id: `act-${event.id}`,
      ts: event.ts,
      icon: '◇',
      label: event.label,
      tone: 'magenta',
      onClick: () =>
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', { detail: { tab: 'workflows' } }),
        ),
    };
  }
  if (k.startsWith('inbox.')) {
    return {
      id: `act-${event.id}`,
      ts: event.ts,
      icon: '▪',
      label: event.label,
      tone: 'slate',
      onClick: () =>
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
        ),
    };
  }
  if (k.startsWith('note.') || k.startsWith('meeting.')) {
    return {
      id: `act-${event.id}`,
      ts: event.ts,
      icon: k.startsWith('meeting.') ? '◉' : '✎',
      label: event.label,
      tone: 'green',
      onClick: () =>
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', {
            detail: {
              tab: 'settings',
              moduleId: k.startsWith('meeting.') ? 'meeting-recorder' : 'quick-note',
            },
          }),
        ),
    };
  }
  if (k.startsWith('reminder.')) {
    return {
      id: `act-${event.id}`,
      ts: event.ts,
      icon: '⏰',
      label: event.label,
      tone: 'amber',
    };
  }
  if (k === 'send.dispatched') {
    return {
      id: `act-${event.id}`,
      ts: event.ts,
      icon: '➤',
      label: event.label,
      tone: 'cyan',
    };
  }
  // Default: render integration / other events with a subtle dot.
  return {
    id: `act-${event.id}`,
    ts: event.ts,
    icon: '·',
    label: event.label,
    tone: 'slate',
  };
}

function browserToChip(visit: { url: string; title: string; at: number }): Chip {
  const host = safeHost(visit.url);
  const label = visit.title?.trim() || visit.url;
  return {
    id: `browser-${visit.url}-${visit.at}`,
    ts: visit.at,
    icon: '⌖',
    label: host ? `${host} · ${label.slice(0, 40)}` : label.slice(0, 50),
    tone: 'cyan',
    onClick: () => void window.jarvis.openExternal(visit.url),
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function formatRel(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return 'just now';
  const m = Math.round(dt / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}
