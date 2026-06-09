import { useEffect, useMemo, useState } from 'react';

import {
  allRepos,
  type InboxItem,
  type ProjectDef,
} from '../../../shared/types';

import { Linkified } from './Linkified';
import { predictAction } from './predictAction';
import { RowSession } from './RowSession';

/**
 * FocusCard — the hero zone of the Bridge.
 *
 * Answers "what do I do next?" in one sentence + one button. Pulled
 * from the smart-curated inbox section (`~/.jarvis/inbox/smart.json`,
 * source = 'smart'). If smart-curate hasn't filled the section yet,
 * falls back to the highest-priority calendar / awaiting item.
 *
 * Iron-Man HUD framing: bracket markers around the headline, a
 * vertical scanline pulse on hover, alignment notches in the corners.
 * Idle = cyan; "imminent" (meeting in < 5 min) = amber; "overdue" =
 * orange-red.
 */

type Tone = 'idle' | 'imminent' | 'overdue';

interface Props {
  /** Trigger the item's primary action (open URL, dispatch task, etc.). */
  onAct(item: InboxItem): void;
  /** When set, Focus narrows to items that belong to this project —
   *  same matching rules as ProjectPulse uses. */
  activeProject?: string | null;
  /** Map of inbox item id → active agent task id. When set, the row
   *  expands to show inline RowSession (status + tail + cancel). */
  activeSessions?: Record<string, string>;
  onCancelSession?(taskId: string): void;
  onOpenSession?(taskId: string): void;
}

export function FocusCard({
  onAct,
  activeProject,
  activeSessions,
  onCancelSession,
  onOpenSession,
}: Props) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [projects, setProjects] = useState<ProjectDef[]>([]);

  useEffect(() => {
    void window.jarvis.listInbox().then(setItems);
    return window.jarvis.onInboxChanged(() => {
      void window.jarvis.listInbox().then(setItems);
    });
  }, []);

  useEffect(() => {
    void window.jarvis.listProjects().then(setProjects);
    return window.jarvis.onProjectsChanged?.(setProjects);
  }, []);

  // Apply project scope BEFORE picking focus. When scope is set, only
  // items matched to that project (via repo / alias / keyword) make
  // it into Focus + Queue. When scope is null, every item is fair
  // game. Same matching logic ProjectPulse uses so the Bridge feels
  // internally consistent.
  //
  // Solo calendar events (lunch blocks, "focus time", "out of office"
  // — anything where I'm the only accepted attendee) are stripped
  // here too. They're personal blockers, not meetings the Bridge
  // should surface as "what to do next." Same rule as the
  // meeting-recording prompt gate (isSoloCalendarBlock in
  // inbox-proximity.ts).
  const scopedItems = useMemo(() => {
    const dropSolo = (it: InboxItem): boolean =>
      !(
        it.source === 'calendar' &&
        typeof it.attendeeCount === 'number' &&
        it.attendeeCount <= 1
      );
    if (!activeProject) return items.filter(dropSolo);
    const active = projects.find((p) => p.name === activeProject);
    if (!active) return items.filter(dropSolo);
    return items
      .filter(dropSolo)
      .filter((it) => itemBelongsToProject(it, active, projects));
  }, [items, activeProject, projects]);

  const focus = useMemo(() => pickFocus(scopedItems), [scopedItems]);
  const grouped = useMemo(
    () => groupQueue(scopedItems, focus),
    [scopedItems, focus],
  );
  const tone = useMemo(() => toneFor(focus), [focus]);

  if (!focus) {
    const scopeNote = activeProject
      ? `${activeProject} is quiet — nothing waiting on you.`
      : 'Inbox is quiet — nothing waiting on you.';
    return (
      <article className="bridge-focus bridge-focus--empty" data-tone="idle">
        <Brackets>
          <header className="bridge-focus__label">
            FOCUS · ALL SYSTEMS NOMINAL
            {activeProject && (
              <span className="bridge-focus__eta">scope · {activeProject}</span>
            )}
          </header>
        </Brackets>
        <p className="bridge-focus__title">{scopeNote}</p>
        <p className="bridge-focus__hint">
          Type into the rail above or hit ⌘⇧J to ask anything.
        </p>
      </article>
    );
  }

  return (
    <article className={`bridge-focus bridge-focus--${tone}`} data-tone={tone}>
      <Brackets>
        <header className="bridge-focus__label">
          FOCUS · {sourceLabel(focus)}
          {focus.fireAt && (
            <span className="bridge-focus__eta">
              {formatEta(focus.fireAt)}
            </span>
          )}
        </header>
      </Brackets>
      <h2 className="bridge-focus__title">
        <Linkified text={focus.title} contextUrl={focus.url} />
      </h2>
      {focus.why && (
        <p className="bridge-focus__why">
          <Linkified text={focus.why} contextUrl={focus.url} />
        </p>
      )}
      {focus.subtitle && (
        <p className="bridge-focus__subtitle">
          <Linkified text={focus.subtitle} contextUrl={focus.url} />
        </p>
      )}
      <div className="bridge-focus__actions">
        <button
          className="bridge-focus__cta"
          onClick={() => onAct(focus)}
        >
          {ctaLabel(focus)}
        </button>
        {focus.url && (
          <a
            className="bridge-focus__secondary"
            href={focus.url}
            onClick={(e) => {
              e.preventDefault();
              void window.jarvis.openExternal(focus.url!);
            }}
          >
            Open ↗
          </a>
        )}
      </div>
      {grouped.length > 0 && (
        <div className="bridge-focus__queue" aria-label="Next up">
          {grouped.map((group) => (
            <section key={group.id} className="bridge-focus__queue-group">
              <header className="bridge-focus__queue-group-head">
                <span className="bridge-focus__queue-label">
                  {group.label}
                </span>
                <span className="bridge-focus__queue-count">
                  [{group.items.length}]
                </span>
              </header>
              <ul className="bridge-focus__queue-list">
                {group.items.map((q) => {
                  const sessionTaskId = activeSessions?.[q.id];
                  const action = predictAction(q);
                  const ctx = [q.subtitle, q.why].filter(Boolean).join(' · ');
                  const tooltip = ctx
                    ? `${ctx}\n→ ${action.tooltip}`
                    : action.tooltip;
                  return (
                    <li key={q.id}>
                      <button
                        className={`bridge-focus__queue-item${
                          sessionTaskId
                            ? ' bridge-focus__queue-item--active'
                            : ''
                        }`}
                        onClick={() => {
                          // While a session is live for this row, the
                          // primary click target is "open the full
                          // transcript" — re-launching would spawn a
                          // duplicate agent for the same item.
                          if (sessionTaskId) {
                            onOpenSession?.(sessionTaskId);
                          } else {
                            void onAct(q);
                          }
                        }}
                        title={
                          sessionTaskId
                            ? 'Agent running — click to open full transcript'
                            : tooltip
                        }
                      >
                        <span className="bridge-focus__queue-title">
                          <Linkified text={q.title} contextUrl={q.url} />
                        </span>
                        {q.fireAt && !sessionTaskId && (
                          <span className="bridge-focus__queue-eta">
                            {formatEta(q.fireAt)}
                          </span>
                        )}
                        {sessionTaskId ? (
                          <span
                            className="bridge-action bridge-action--running"
                            aria-hidden
                          >
                            <span className="bridge-action__icon">●</span>
                            <span className="bridge-action__label">RUNNING</span>
                          </span>
                        ) : (
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
                        )}
                      </button>
                      {sessionTaskId && onCancelSession && onOpenSession && (
                        <RowSession
                          taskId={sessionTaskId}
                          onCancel={onCancelSession}
                          onOpenFull={onOpenSession}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Bucket each inbox item into one of a handful of human-readable
 * groups, then return the non-empty groups in priority order. The
 * Bridge previously rendered the queue as a flat list of cryptic
 * source labels (PR-COMMENTS / AUTOPILOT-DRAFTS / FAILED-ROUTINES
 * mixed) — which is technically correct but not how a user thinks
 * about their day. Grouping converts that into:
 *
 *   - Waiting on you    (PRs, Linear tickets, mentions, scheduled
 *                        reminders — anything explicitly needing
 *                        your action)
 *   - Today             (calendar items in the next 12 hours)
 *   - From meetings     (work-awareness commitments / action items)
 *   - Drafted for you   (autopilot drafts ready to send)
 *
 * Sources that look like system noise (`failed-routines`,
 * `meeting-heads-up`, raw module emissions) get filtered out — they
 * belong in the Stream ticker, not in the user's todo list.
 */
interface FocusGroup {
  id: 'waiting' | 'today' | 'meetings' | 'drafts';
  label: string;
  items: InboxItem[];
}

const GROUP_LABELS: Record<FocusGroup['id'], string> = {
  waiting: 'WAITING ON YOU',
  today: 'TODAY',
  meetings: 'FROM MEETINGS',
  drafts: 'DRAFTED FOR YOU',
};

/** Sources that should NOT appear in the queue. They're either pure
 *  system signals (failed routines, meeting detection prompts) or
 *  already represented by another zone (the Focus hero itself). */
const QUEUE_HIDDEN_SOURCES = new Set([
  'failed-routines',
  'meeting-heads-up',
  'smart', // smart-curated items are surfaced as the Focus hero already
]);

function groupFor(item: InboxItem): FocusGroup['id'] | null {
  if (QUEUE_HIDDEN_SOURCES.has(item.source)) return null;
  if (item.source === 'calendar') return 'today';
  if (item.source === 'drafts') return 'drafts';
  if (item.source === 'work-awareness') return 'meetings';
  if (item.source.startsWith('pr-') || item.source === 'github') {
    return 'waiting';
  }
  if (
    item.source === 'reminders' ||
    item.source === 'awaiting' ||
    item.source === 'slack' ||
    item.source === 'linear'
  ) {
    return 'waiting';
  }
  // Anything else — treat as waiting (default), but only if it has
  // enough signal to merit a row.
  if (item.title.trim().length === 0) return null;
  return 'waiting';
}

function groupQueue(items: InboxItem[], focus: InboxItem | null): FocusGroup[] {
  if (items.length === 0) return [];
  const focusId = focus?.id;
  const buckets: Record<FocusGroup['id'], InboxItem[]> = {
    waiting: [],
    today: [],
    meetings: [],
    drafts: [],
  };
  for (const item of items) {
    if (item.id === focusId) continue;
    if (!item.title) continue;
    const g = groupFor(item);
    if (!g) continue;
    buckets[g].push(item);
  }
  // Sort inside each bucket: time-pressured first, then recency.
  const now = Date.now();
  for (const id of Object.keys(buckets) as FocusGroup['id'][]) {
    buckets[id].sort((a, b) => {
      if (a.fireAt && b.fireAt) return a.fireAt - b.fireAt;
      if (a.fireAt) return -1;
      if (b.fireAt) return 1;
      return b.createdAt - a.createdAt;
    });
    // Cap each group at 4 rows so a noisy source can't dominate the
    // queue. The user can drill into the Inbox for the full list.
    buckets[id] = buckets[id].slice(0, 4);
  }
  // Today filter: drop calendar items more than 12h in the future
  // (those live on the Today timeline anyway).
  const horizonMs = 12 * 60 * 60_000;
  buckets.today = buckets.today.filter(
    (i) =>
      i.fireAt != null &&
      i.fireAt > now - 60_000 &&
      i.fireAt < now + horizonMs,
  );
  // Stable order: most-pressing first.
  const order: FocusGroup['id'][] = ['waiting', 'today', 'meetings', 'drafts'];
  return order
    .map((id) => ({ id, label: GROUP_LABELS[id], items: buckets[id] }))
    .filter((g) => g.items.length > 0);
}

/** Pick the single item that deserves the hero card. Order:
 *    1. smart-curated section (already ranked by Haiku)
 *    2. fireAt within 30 min (imminent meeting / reminder)
 *    3. any awaiting item with a draft / action
 *    4. anything else — first row of the inbox
 */
function pickFocus(items: InboxItem[]): InboxItem | null {
  if (items.length === 0) return null;
  const smart = items.find((i) => i.source === 'smart');
  if (smart) return smart;
  const now = Date.now();
  const imminent = items
    .filter((i) => i.fireAt && i.fireAt > now - 60_000 && i.fireAt < now + 30 * 60_000)
    .sort((a, b) => (a.fireAt ?? 0) - (b.fireAt ?? 0))[0];
  if (imminent) return imminent;
  return items[0] ?? null;
}

function toneFor(focus: InboxItem | null): Tone {
  if (!focus || focus.fireAt == null) return 'idle';
  const dt = focus.fireAt - Date.now();
  if (dt < 0) return 'overdue';
  if (dt < 5 * 60_000) return 'imminent';
  return 'idle';
}

/**
 * CTA verb tuned to the item's nature. The user's primary intent
 * changes per source: a PR wants to be reviewed, a Slack thread
 * wants a reply, a meeting wants to be joined, a reminder wants
 * to be marked done. Generic "→ Act" hides the actual next move.
 *
 * Source-name conventions:
 *   - 'calendar'         → calendar/meeting items (workflow: calendar-today-sync)
 *   - 'pr-*' / 'github'  → PRs from gh sources
 *   - 'reminders'        → ReminderStore fires
 *   - 'slack'            → Slack inbox feed
 *   - 'linear'           → Linear inbox feed
 *   - 'drafts'           → DraftsStore-written items
 *   - 'work-awareness'   → action items synthesised from meeting transcripts
 *   - 'smart'            → top-of-stack smart-curated section
 *
 * `item.action.label` always wins when the source set one (autopilot
 * drafts in particular set a custom label like "Send reply").
 */
function ctaLabel(item: InboxItem): string {
  if (item.action?.label) return item.action.label;
  if (item.source === 'calendar') return '▶ Join meeting';
  if (item.source === 'reminders') return '✓ Mark done';
  if (item.source.startsWith('pr-') || item.source === 'github') {
    return '◆ Review PR';
  }
  if (item.source === 'slack') return '↩ Reply';
  if (item.source === 'linear') return '→ Open ticket';
  if (item.source === 'drafts') return '✎ Review draft';
  if (item.source === 'work-awareness') return '✓ Mark addressed';
  return '→ Act';
}

/**
 * Project membership — mirrors ProjectPulse.matchInboxProject so
 * scope filtering produces the same set the Pulse counts. Kept as
 * a local helper to avoid coupling FocusCard to the Pulse module's
 * internals; if/when we extract a shared matcher this becomes a
 * single import.
 */
function itemBelongsToProject(
  item: InboxItem,
  active: ProjectDef,
  allProjects: ProjectDef[],
): boolean {
  // Exact project field — strongest signal.
  if (item.project) {
    const fromField = allProjects.find(
      (p) =>
        p.name.toLowerCase() === item.project!.toLowerCase() ||
        p.aliases.some((a) => a.toLowerCase() === item.project!.toLowerCase()),
    );
    return fromField?.name === active.name;
  }
  const haystack =
    `${item.title} ${item.subtitle ?? ''} ${item.url ?? ''}`.toLowerCase();
  if (!haystack.trim()) return false;
  for (const repo of allRepos(active)) {
    const needle = repo.toLowerCase();
    if (needle && haystack.includes(needle)) return true;
    const shortName = needle.split('/').pop();
    if (shortName && shortName.length > 3 && haystack.includes(shortName)) {
      return true;
    }
  }
  if (haystack.includes(active.name.toLowerCase())) return true;
  for (const a of active.aliases) {
    if (a.length > 2 && haystack.includes(a.toLowerCase())) return true;
  }
  for (const k of active.keywords ?? []) {
    if (k.length > 2 && haystack.includes(k.toLowerCase())) return true;
  }
  return false;
}

function sourceLabel(item: InboxItem): string {
  if (item.source === 'smart') return 'CURATED';
  return item.source.toUpperCase();
}

function formatEta(fireAt: number): string {
  const dt = fireAt - Date.now();
  if (dt < 0) {
    const mins = Math.round(-dt / 60_000);
    return mins < 60 ? `${mins}m late` : `${Math.round(mins / 60)}h late`;
  }
  const mins = Math.round(dt / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.round(mins / 60)}h`;
}

/** Renders the HUD bracket markers around the child. Pure CSS would
 *  work but the bracket positioning is easier to reason about with a
 *  dedicated wrapper. */
function Brackets({ children }: { children: React.ReactNode }) {
  return (
    <div className="bridge-brackets">
      <span className="bridge-brackets__tl" aria-hidden />
      <span className="bridge-brackets__tr" aria-hidden />
      {children}
      <span className="bridge-brackets__bl" aria-hidden />
      <span className="bridge-brackets__br" aria-hidden />
    </div>
  );
}
