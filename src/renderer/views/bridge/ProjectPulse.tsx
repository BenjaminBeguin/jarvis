import { useEffect, useMemo, useState } from 'react';

import {
  allRepos,
  type InboxItem,
  type ProjectDef,
  type TaskSummary,
} from '../../../shared/types';

import { useWorkspace } from '../workspaces/useWorkspace';
import { Linkified } from './Linkified';
import { predictAction } from './predictAction';

/** Which stat (per project) is expanded into a drilldown. null = none. */
type DrilldownKey = `${string}:${StatKey}`;
type StatKey = 'prs' | 'awaiting' | 'meetings' | 'drafts';

/**
 * Calendar items where I'm the only accepted attendee (lunch, focus
 * blocks, "out of office", etc.) shouldn't count as meetings — they're
 * personal blocks, not group sessions. Same gate the meeting-recording
 * prompt uses in inbox-proximity.ts so the Bridge and the prompt agree
 * on what counts as a "real" meeting.
 */
function isSoloCalendarBlock(item: InboxItem): boolean {
  if (item.source !== 'calendar') return false;
  if (typeof item.attendeeCount !== 'number') return false;
  return item.attendeeCount <= 1;
}

/**
 * ProjectPulse — middle zone of the Bridge.
 *
 * One card per known project. Each card surfaces a small "vitals"
 * panel: open PRs, awaiting Slack/Linear threads, meetings today,
 * drafts waiting, active tasks. Click a card → activates that project
 * scope globally (same as clicking it in the Shell scope picker), and
 * the Bridge filters down to that project's signal.
 *
 * Live: re-renders on inbox + task changes. Animations: each card has
 * a faint scanline; the active project's card pulses cyan along its
 * left edge.
 *
 * Iron-Man HUD framing: bracket markers, alignment notches between
 * cards, tabular-figures font for stats so columns of digits sit
 * flush on the eye.
 */

interface Vitals {
  /** Open Linear / GitHub PR rows tagged to this project. */
  prs: number;
  /** Slack / DM / mention rows awaiting your reply for this project. */
  awaiting: number;
  /** Calendar items scheduled today (≤ 24h) tagged to this project. */
  meetings: number;
  /** Drafts written but not sent for this project. */
  drafts: number;
  /** Tasks the agent has running for this project right now. */
  liveTasks: number;
  /** Last activity timestamp — drives the freshness label. */
  lastActivity: number | null;
}

interface Props {
  activeProject: string | null;
  onSelectProject(name: string): void;
}

export function ProjectPulse({ activeProject, onSelectProject }: Props) {
  const [projectsAll, setProjectsAll] = useState<ProjectDef[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const workspace = useWorkspace();

  useEffect(() => {
    void window.jarvis.listProjects().then(setProjectsAll);
    return window.jarvis.onProjectsChanged?.(setProjectsAll);
  }, []);

  // Workspace-scoped projects — only cards for the current workspace
  // render. Workspace-less projects ("global") appear in every
  // workspace as a fall-through, matching the rest of the app.
  const projects = useMemo(
    () => projectsAll.filter((p) => workspace.belongs(p)),
    [projectsAll, workspace],
  );

  useEffect(() => {
    void window.jarvis.listInbox().then(setInbox);
    return window.jarvis.onInboxChanged(setInbox);
  }, []);

  useEffect(() => {
    void window.jarvis.listTasks().then(setTasks);
    const offStatus = window.jarvis.onTaskStatus((s) => {
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === s.id);
        if (i === -1) return [s, ...prev];
        const next = prev.slice();
        next[i] = s;
        return next;
      });
    });
    const offRemoved = window.jarvis.onTaskRemoved((id) => {
      setTasks((prev) => prev.filter((t) => t.id !== id));
    });
    return () => {
      offStatus();
      offRemoved();
    };
  }, []);

  const vitalsByProject = useMemo(
    () => computeVitals(projects, inbox, tasks),
    [projects, inbox, tasks],
  );
  // Group inbox items by project + stat so the drilldown can render
  // the underlying rows without recomputing per click.
  const itemsByProjectStat = useMemo(
    () => groupItemsByProjectStat(projects, inbox),
    [projects, inbox],
  );

  const [openDrill, setOpenDrill] = useState<DrilldownKey | null>(null);
  const toggleDrill = (project: string, stat: StatKey): void => {
    const key = `${project}:${stat}` as DrilldownKey;
    setOpenDrill((prev) => (prev === key ? null : key));
  };

  if (projects.length === 0) {
    return (
      <section className="bridge-pulse bridge-pulse--empty">
        <span className="bridge-pulse__hint">
          No projects yet. Settings → Projects to add one.
        </span>
      </section>
    );
  }

  return (
    <section className="bridge-pulse">
      {projects.map((p) => {
        const v = vitalsByProject[p.name] ?? emptyVitals();
        const total = v.prs + v.awaiting + v.meetings + v.drafts;
        const tone = total === 0 ? 'idle' : total > 5 ? 'hot' : 'warm';
        const isActive = activeProject === p.name;
        const drillStat = openDrill?.startsWith(`${p.name}:`)
          ? (openDrill.slice(p.name.length + 1) as StatKey)
          : null;
        const drillItems = drillStat
          ? (itemsByProjectStat[p.name]?.[drillStat] ?? [])
          : [];
        return (
          <div
            key={p.name}
            className={`bridge-pulse__card bridge-pulse__card--${tone}${
              isActive ? ' bridge-pulse__card--active' : ''
            }${drillStat ? ' bridge-pulse__card--expanded' : ''}`}
            title={p.description ?? `${p.name}`}
          >
            <header className="bridge-pulse__header">
              <button
                type="button"
                className="bridge-pulse__name-btn"
                onClick={() => onSelectProject(p.name)}
                title={
                  isActive ? `Clear scope` : `Switch scope to ${p.name}`
                }
              >
                <span className="bridge-pulse__name">{p.name}</span>
              </button>
              {allRepos(p).length > 0 && (
                <span
                  className="bridge-pulse__repo"
                  title={allRepos(p).join('\n')}
                >
                  {formatRepos(allRepos(p))}
                </span>
              )}
            </header>
            <div className="bridge-pulse__vitals">
              <Stat
                label="PRS"
                stat="prs"
                value={v.prs}
                project={p.name}
                openDrill={drillStat}
                onToggle={toggleDrill}
              />
              <Stat
                label="AWAITING"
                stat="awaiting"
                value={v.awaiting}
                project={p.name}
                openDrill={drillStat}
                onToggle={toggleDrill}
              />
              <Stat
                label="TODAY"
                stat="meetings"
                value={v.meetings}
                project={p.name}
                openDrill={drillStat}
                onToggle={toggleDrill}
              />
              <Stat
                label="DRAFTS"
                stat="drafts"
                value={v.drafts}
                project={p.name}
                openDrill={drillStat}
                onToggle={toggleDrill}
              />
            </div>
            <footer className="bridge-pulse__footer">
              {v.liveTasks > 0 ? (
                <span className="bridge-pulse__live">
                  ● {v.liveTasks} live
                </span>
              ) : v.lastActivity ? (
                <span className="bridge-pulse__last">
                  {formatRel(v.lastActivity)} ago
                </span>
              ) : (
                <span className="bridge-pulse__quiet">quiet</span>
              )}
            </footer>
            {drillStat && drillItems.length > 0 && (
              <div className="bridge-pulse__drill">
                <span className="bridge-pulse__drill-label">
                  {drillStat.toUpperCase()}
                </span>
                <ul className="bridge-pulse__drill-list">
                  {drillItems.slice(0, 8).map((item) => {
                    const action = predictAction(item);
                    const ctx = [item.subtitle, item.why]
                      .filter(Boolean)
                      .join(' · ');
                    const tooltip = ctx
                      ? `${ctx}\n→ ${action.tooltip}`
                      : action.tooltip;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="bridge-pulse__drill-item"
                          onClick={() => {
                            if (item.url) {
                              void window.jarvis.openExternal(item.url);
                            } else {
                              window.dispatchEvent(
                                new CustomEvent('jarvis:navigate', {
                                  detail: { tab: 'inbox' },
                                }),
                              );
                            }
                          }}
                          title={tooltip}
                        >
                          <div className="bridge-pulse__drill-main">
                            <span className="bridge-pulse__drill-title">
                              <Linkified
                                text={item.title}
                                contextUrl={item.url}
                              />
                            </span>
                            {item.subtitle && (
                              <span className="bridge-pulse__drill-sub">
                                <Linkified
                                  text={item.subtitle}
                                  contextUrl={item.url}
                                />
                              </span>
                            )}
                          </div>
                          <span
                            className={`bridge-action bridge-action--${action.tone}`}
                            aria-hidden
                          >
                            <span className="bridge-action__icon">
                              {action.icon}
                            </span>
                            <span className="bridge-action__label">
                              {action.label}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {drillItems.length > 8 && (
                  <span className="bridge-pulse__drill-more">
                    +{drillItems.length - 8} more · open Inbox
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Stat({
  label,
  stat,
  value,
  project,
  openDrill,
  onToggle,
}: {
  label: string;
  stat: StatKey;
  value: number;
  project: string;
  openDrill: StatKey | null;
  onToggle(project: string, stat: StatKey): void;
}) {
  const open = openDrill === stat;
  const disabled = value === 0;
  return (
    <button
      type="button"
      className={`bridge-stat${value > 0 ? ' bridge-stat--on' : ''}${
        open ? ' bridge-stat--open' : ''
      }`}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onToggle(project, stat);
      }}
      disabled={disabled}
      title={disabled ? `No ${label.toLowerCase()}` : `Show ${value} ${label.toLowerCase()}`}
    >
      <span className="bridge-stat__value">[{value}]</span>
      <span className="bridge-stat__label">{label}</span>
    </button>
  );
}

function emptyVitals(): Vitals {
  return {
    prs: 0,
    awaiting: 0,
    meetings: 0,
    drafts: 0,
    liveTasks: 0,
    lastActivity: null,
  };
}

function computeVitals(
  projects: ProjectDef[],
  inbox: InboxItem[],
  tasks: TaskSummary[],
): Record<string, Vitals> {
  const out: Record<string, Vitals> = {};
  for (const p of projects) out[p.name] = emptyVitals();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  for (const item of inbox) {
    const projectName = matchInboxProject(item, projects);
    if (!projectName) continue;
    const v = out[projectName];
    if (!v) continue;
    // PR-ish sources
    if (item.source.startsWith('pr-') || item.source === 'github') v.prs++;
    // Awaiting-shaped sources
    else if (
      item.source === 'slack' ||
      item.source === 'linear' ||
      item.source === 'awaiting'
    ) {
      v.awaiting++;
    }
    // Calendar items in the next 24h. Solo blockers (lunch, focus
    // time, "out of office" — anything where I'm the only accepted
    // attendee) don't count as meetings the user needs to "be aware
    // of" — they're personal blocks.
    else if (
      item.source === 'calendar' &&
      item.fireAt &&
      item.fireAt > now - 60_000 &&
      item.fireAt < now + dayMs &&
      !isSoloCalendarBlock(item)
    ) {
      v.meetings++;
    }
    // Drafts module shows drafts via inbox
    else if (item.source === 'drafts') v.drafts++;
    // Track lastActivity from createdAt
    if (!v.lastActivity || item.createdAt > v.lastActivity) {
      v.lastActivity = item.createdAt;
    }
  }
  for (const t of tasks) {
    if (!t.projectName) continue;
    const v = out[t.projectName];
    if (!v) continue;
    if (t.status === 'running' || t.status === 'queued') v.liveTasks++;
    if (!v.lastActivity || t.startedAt > v.lastActivity) {
      v.lastActivity = t.startedAt;
    }
  }
  return out;
}

/**
 * Pre-bucket every inbox item by (project, stat) so the drilldown
 * panel can pull the exact rows without recomputing on each click.
 * Same bucketing logic as computeVitals — kept in sync intentionally
 * so the count in the chip and the list length always match.
 */
function groupItemsByProjectStat(
  projects: ProjectDef[],
  inbox: InboxItem[],
): Record<string, Record<StatKey, InboxItem[]>> {
  const out: Record<string, Record<StatKey, InboxItem[]>> = {};
  for (const p of projects) {
    out[p.name] = { prs: [], awaiting: [], meetings: [], drafts: [] };
  }
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  for (const item of inbox) {
    const projectName = matchInboxProject(item, projects);
    if (!projectName) continue;
    const bucket = out[projectName];
    if (!bucket) continue;
    if (item.source.startsWith('pr-') || item.source === 'github') {
      bucket.prs.push(item);
    } else if (
      item.source === 'slack' ||
      item.source === 'linear' ||
      item.source === 'awaiting'
    ) {
      bucket.awaiting.push(item);
    } else if (
      item.source === 'calendar' &&
      item.fireAt &&
      item.fireAt > now - 60_000 &&
      item.fireAt < now + dayMs &&
      !isSoloCalendarBlock(item)
    ) {
      bucket.meetings.push(item);
    } else if (item.source === 'drafts') {
      bucket.drafts.push(item);
    }
  }
  // Sort each bucket: time-pressured first, then recency.
  for (const project of Object.keys(out)) {
    for (const key of ['prs', 'awaiting', 'meetings', 'drafts'] as StatKey[]) {
      out[project]![key].sort((a, b) => {
        if (a.fireAt && b.fireAt) return a.fireAt - b.fireAt;
        if (a.fireAt) return -1;
        if (b.fireAt) return 1;
        return b.createdAt - a.createdAt;
      });
    }
  }
  return out;
}

/**
 * Decide which project an inbox item belongs to. Order of preference:
 *
 *   1. Explicit `item.project` field matches a ProjectDef name/alias.
 *   2. Item URL or subtitle contains one of the project's configured
 *      repos (handles "PR #3872 in hive-engineering/merchant-app" →
 *      Merchant project).
 *   3. Item title/subtitle contains the project name, an alias, or a
 *      configured keyword (catches "Linear MXG-876 …" via the "mxg"
 *      keyword on the Merchant project).
 *
 * Multi-tenancy: when more than one project claims an item (e.g. a
 * monolith repo registered on two projects), we return the FIRST
 * match in the order projects appear in projects.json. The user
 * controls ranking by ordering projects intentionally there.
 */
function matchInboxProject(
  item: InboxItem,
  projects: ProjectDef[],
): string | null {
  if (item.project) {
    const exact = projects.find(
      (p) =>
        p.name.toLowerCase() === item.project!.toLowerCase() ||
        p.aliases.some((a) => a.toLowerCase() === item.project!.toLowerCase()),
    );
    if (exact) return exact.name;
  }
  const haystack = `${item.title} ${item.subtitle ?? ''} ${item.url ?? ''}`.toLowerCase();
  if (!haystack.trim()) return null;
  // Pass 1: repo match — strongest signal.
  for (const p of projects) {
    for (const repo of allRepos(p)) {
      const needle = repo.toLowerCase();
      if (needle && haystack.includes(needle)) return p.name;
      // Strip owner/ prefix and try the short name too — many PR
      // subtitles read "merchant-app · by @user" without the owner.
      const shortName = needle.split('/').pop();
      if (shortName && shortName.length > 3 && haystack.includes(shortName)) {
        return p.name;
      }
    }
  }
  // Pass 2: name / alias / keyword. Skip 1-2 char aliases to avoid
  // false positives on common substrings ("a", "ui", etc.).
  for (const p of projects) {
    if (haystack.includes(p.name.toLowerCase())) return p.name;
    for (const a of p.aliases) {
      if (a.length > 2 && haystack.includes(a.toLowerCase())) return p.name;
    }
    for (const k of p.keywords ?? []) {
      if (k.length > 2 && haystack.includes(k.toLowerCase())) return p.name;
    }
  }
  return null;
}

function shortRepo(repo: string): string {
  const clean = repo.replace(/^https?:\/\/(www\.)?github\.com\//, '');
  const parts = clean.split('/');
  if (parts.length === 2) return parts[1] ?? clean;
  return clean;
}

/** Render a compact repo summary for the card header. Shows the
 *  first repo by name; appends "+N" if there are more so the badge
 *  signals "this project has multiple repos" without bloating the
 *  layout. Hover the badge → full list (title attribute). */
function formatRepos(repos: string[]): string {
  if (repos.length === 0) return '';
  const first = shortRepo(repos[0]!);
  if (repos.length === 1) return first;
  return `${first} +${repos.length - 1}`;
}

function formatRel(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return 'just now';
  const m = Math.round(dt / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
