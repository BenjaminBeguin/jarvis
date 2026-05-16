import { useEffect, useMemo, useState } from 'react';

import type {
  InboxItem,
  MeetingDetectionStatus,
  Reminder,
  RoutineDef,
  TaskSummary,
} from '../../shared/types';
import { toast } from './Toaster';

/**
 * "Now" — the attention synthesis surface. Pulls live state from
 * tasks / inbox / reminders / routines and renders the answer to
 * "what should I look at right now?" in three bands:
 *
 *   1. In progress: tasks awaiting your reply + tasks currently
 *      running. The agent loop is mid-flight here.
 *   2. Imminent: anything with a fire time in the next 30 minutes
 *      (reminders, calendar, time-pressured inbox).
 *   3. Broken: routines that errored today — the silent-failure trap
 *      we built streak detection for, hoisted to the top so it
 *      doesn't get buried.
 *
 * Refreshes on every event stream (tasks, reminders, inbox) so the
 * page is always live without a manual reload. Stats footer gives
 * the day's running totals so you can sanity-check spend at a
 * glance.
 *
 * Distinct from:
 *   - Dashboard (curated layout — you decide what goes where)
 *   - Observatory (full live list of every running task)
 *   - Inbox (the flat queue, no time-cut)
 *   - Today Focus (8am snapshot, stale by lunch)
 *
 * Today Focus answers "what's important *today*"; Now answers
 * "what's important *right now*." Different time scopes, different
 * surfaces.
 */
export function Now() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [routines, setRoutines] = useState<RoutineDef[]>([]);
  const [detection, setDetection] = useState<MeetingDetectionStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Initial loads + live subscriptions.
    void window.jarvis.listTasks().then(setTasks);
    void window.jarvis.listInbox().then(setInbox);
    void window.jarvis.listReminders().then(setReminders);
    void window.jarvis.listRoutines().then(setRoutines);
    void window.jarvis.meetingDetectionStatus().then(setDetection);
    const offTaskStatus = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === summary.id);
        if (i === -1) return [summary, ...prev];
        const next = prev.slice();
        next[i] = summary;
        return next;
      });
    });
    const offTaskRemoved = window.jarvis.onTaskRemoved((id) =>
      setTasks((prev) => prev.filter((t) => t.id !== id)),
    );
    const offInbox = window.jarvis.onInboxChanged(setInbox);
    const offReminders = window.jarvis.onRemindersChanged(setReminders);
    const offRoutines = window.jarvis.onRoutinesChanged(setRoutines);
    const offDetection = window.jarvis.onMeetingDetectionChanged(setDetection);
    // Re-tick every 20s so relative times stay fresh + items cross
    // the 30-min threshold organically.
    const tick = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => {
      offTaskStatus();
      offTaskRemoved();
      offInbox();
      offReminders();
      offRoutines();
      offDetection();
      window.clearInterval(tick);
    };
  }, []);

  // ── Band 1: in progress ──────────────────────────────────────────
  // Awaiting input goes first — those are blocked on you.
  const awaitingInput = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.awaitingInput &&
          t.status === 'running' &&
          t.origin !== 'external',
      ),
    [tasks],
  );
  const runningOther = useMemo(
    () =>
      tasks.filter(
        (t) =>
          !t.awaitingInput &&
          t.status === 'running' &&
          t.origin !== 'external',
      ),
    [tasks],
  );

  // ── Band 2: imminent (next 30 min) ───────────────────────────────
  const IMMINENT_MS = 30 * 60 * 1000;
  const imminent = useMemo(() => {
    const items: Array<{
      id: string;
      kind: 'reminder' | 'inbox';
      title: string;
      subtitle?: string;
      fireAt: number;
      taskAction?: () => void;
    }> = [];
    for (const r of reminders) {
      if (r.status !== 'pending') continue;
      const delta = r.fireAt - now;
      if (delta < 0 || delta > IMMINENT_MS) continue;
      items.push({
        id: `rem-${r.id}`,
        kind: 'reminder',
        title: r.body,
        subtitle: r.mode === 'scheduled' ? 'Scheduled action' : 'Reminder',
        fireAt: r.fireAt,
      });
    }
    for (const it of inbox) {
      if (it.fireAt == null) continue;
      const delta = it.fireAt - now;
      if (delta < 0 || delta > IMMINENT_MS) continue;
      // Skip reminders surfaced via the reminders inbox source — we
      // already showed them from the reminders list above. Dedup by
      // common "reminder-" id prefix to avoid double-rows.
      if (it.id.startsWith('reminder-')) continue;
      items.push({
        id: it.id,
        kind: 'inbox',
        title: it.title,
        subtitle: it.subtitle ?? it.source,
        fireAt: it.fireAt,
      });
    }
    return items.sort((a, b) => a.fireAt - b.fireAt);
  }, [reminders, inbox, now]);

  // ── Band 3: broken today ─────────────────────────────────────────
  // Tasks errored today that came from a routine. Uses the new
  // routineId link so this is now an exact filter, not a guess.
  const dayStart = useMemo(() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, [now]);
  const brokenToday = useMemo(() => {
    return tasks
      .filter(
        (t) =>
          t.origin === 'routine' &&
          t.status === 'errored' &&
          t.startedAt >= dayStart,
      )
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [tasks, dayStart]);

  // ── Footer stats ─────────────────────────────────────────────────
  const stats = useMemo(() => {
    const today = tasks.filter((t) => t.startedAt >= dayStart);
    const completed = today.filter((t) => t.status === 'completed').length;
    const errored = today.filter((t) => t.status === 'errored').length;
    const running = today.filter((t) => t.status === 'running').length;
    const cost = today.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
    return { completed, errored, running, cost, total: today.length };
  }, [tasks, dayStart]);

  const totalNeedsAttention = awaitingInput.length + imminent.length + brokenToday.length;

  return (
    <div className="now">
      <header className="now__header">
        <div>
          <h2>NOW</h2>
          <span className="now__time">{formatClock(now)}</span>
        </div>
        <span className="now__total" title="Items wanting attention right now">
          {totalNeedsAttention === 0
            ? 'clear'
            : `${totalNeedsAttention} need${totalNeedsAttention === 1 ? 's' : ''} you`}
        </span>
      </header>

      <MeetingBand detection={detection} now={now} />

      <Band
        title="In progress"
        emptyHint={
          runningOther.length === 0
            ? 'Nothing running. Hit ⌘⇧J to start something.'
            : undefined
        }
        count={awaitingInput.length + runningOther.length}
      >
        {awaitingInput.map((t) => (
          <Row
            key={t.id}
            kind="awaiting"
            primary={t.title}
            secondary={`${t.skillId ?? 'palette task'} · waiting for your reply`}
            time={formatRel(now - t.startedAt)}
            routineId={t.routineId ?? null}
            reminderId={t.reminderId ?? null}
            projectName={t.projectName ?? null}
            onOpen={() => focusTask(t.id)}
          />
        ))}
        {runningOther.map((t) => (
          <Row
            key={t.id}
            kind="running"
            primary={t.title}
            secondary={`${t.skillId ?? 'palette task'} · running`}
            time={formatRel(now - t.startedAt)}
            routineId={t.routineId ?? null}
            reminderId={t.reminderId ?? null}
            projectName={t.projectName ?? null}
            onOpen={() => focusTask(t.id)}
          />
        ))}
      </Band>

      <Band
        title="Next 30 min"
        emptyHint={imminent.length === 0 ? 'Nothing fires in the next 30 minutes.' : undefined}
        count={imminent.length}
      >
        {imminent.map((it) => (
          <Row
            key={it.id}
            kind={it.kind === 'reminder' ? 'imminent-reminder' : 'imminent-inbox'}
            primary={it.title}
            secondary={it.subtitle}
            time={formatCountdown(it.fireAt - now)}
            onOpen={() => navigateTo('inbox')}
          />
        ))}
      </Band>

      <Band
        title="Broken today"
        emptyHint={
          brokenToday.length === 0
            ? `${routines.filter((r) => r.enabled).length} routines enabled · all healthy.`
            : undefined
        }
        count={brokenToday.length}
      >
        {brokenToday.map((t) => (
          <Row
            key={t.id}
            kind="errored"
            primary={t.title}
            secondary={`Routine errored · ${t.routineId ?? t.skillId ?? 'unknown'}`}
            time={formatRel(now - t.startedAt)}
            routineId={t.routineId ?? null}
            onOpen={() => focusTask(t.id)}
          />
        ))}
      </Band>

      <footer className="now__stats">
        <span>
          <strong>{stats.total}</strong> tasks today
        </span>
        <span className="now__stat-sep">·</span>
        <span title={`${stats.completed} done · ${stats.errored} errored · ${stats.running} running`}>
          <strong className="now__stat-good">{stats.completed}</strong> done
          {stats.errored > 0 && (
            <>
              {' · '}
              <strong className="now__stat-bad">{stats.errored}</strong> errored
            </>
          )}
          {stats.running > 0 && (
            <>
              {' · '}
              <strong>{stats.running}</strong> running
            </>
          )}
        </span>
        <span className="now__stat-sep">·</span>
        <span>${stats.cost.toFixed(2)} spent</span>
      </footer>
    </div>
  );
}

/**
 * Meeting band — manual "Record now" button + auto-detect status pill.
 * Sits at the top of Now because catching a meeting fast matters; if
 * the user is already mid-call, this is the action they want.
 *
 * The detection pill is honest about what's happening:
 *   - "auto-detect: live"     log stream is alive AND has seen
 *                              recent mic activity
 *   - "auto-detect: quiet"    log stream alive but silent for >60s
 *                              after start (the macOS 15 case)
 *   - "auto-detect: fault"    spawn / stream error
 *
 * In all cases the Record button works — it doesn't depend on
 * detection. The pill is just transparency.
 */
function MeetingBand({
  detection,
  now,
}: {
  detection: MeetingDetectionStatus | null;
  now: number;
}) {
  const [busy, setBusy] = useState(false);

  const detectState: 'live' | 'quiet' | 'fault' | 'off' = (() => {
    if (!detection) return 'off';
    if (detection.fault) return 'fault';
    if (!detection.running) return 'off';
    if (detection.inputEventsSeen > 0) {
      // "Live" only if we saw mic activity recently (last 5 min) —
      // otherwise the stream is just running, not actively reporting.
      if (
        detection.lastInputAt &&
        now - detection.lastInputAt < 5 * 60_000
      ) {
        return 'live';
      }
      return 'quiet';
    }
    // Running but zero matching events yet. Quiet if past the
    // grace window.
    return now - detection.startedAt > 60_000 ? 'quiet' : 'live';
  })();

  const pillText =
    detectState === 'live'
      ? 'auto-detect: live'
      : detectState === 'quiet'
      ? 'auto-detect: quiet'
      : detectState === 'fault'
      ? 'auto-detect: fault'
      : 'auto-detect: off';

  const pillTitle =
    detectState === 'fault'
      ? detection?.fault ?? 'Watcher errored.'
      : detectState === 'quiet'
      ? 'macOS 15 quiets the audio log channel — auto-detect is best-effort. Use Record manually for ad-hoc calls.'
      : detectState === 'live'
      ? `Saw ${detection?.inputEventsSeen ?? 0} mic event(s) since start.`
      : 'Watcher not started yet.';

  const record = async () => {
    setBusy(true);
    try {
      const result = await window.jarvis.dispatchIntent(
        'meeting-recorder',
        'start',
        '',
      );
      if (result.ok) {
        toast({ message: result.message ?? 'Recording started' });
      } else {
        toast({ kind: 'error', message: result.message ?? 'Failed to start' });
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

  return (
    <section className="now__band now__band--meeting">
      <header className="now__band-head">
        <h3>Meeting</h3>
        <span
          className={`now__detect now__detect--${detectState}`}
          title={pillTitle}
        >
          {pillText}
        </span>
      </header>
      <div className="now__meeting-row">
        <button
          className="now__record-btn"
          onClick={record}
          disabled={busy}
          title="Start recording the current meeting (Whisper, local)"
        >
          🎙 {busy ? 'Starting…' : 'Record now'}
        </button>
        <span className="now__meeting-hint">
          {detectState === 'quiet' || detectState === 'fault'
            ? 'Auto-detect is unreliable on macOS 15 — the calendar prompt + this button are the reliable paths.'
            : 'Click to start a manual recording, or wait for the calendar / mic prompt.'}
        </span>
      </div>
    </section>
  );
}

function Band({
  title,
  count,
  emptyHint,
  children,
}: {
  title: string;
  count: number;
  emptyHint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="now__band">
      <header className="now__band-head">
        <h3>{title}</h3>
        <span className="now__band-count">{count}</span>
      </header>
      {count === 0 && emptyHint ? (
        <div className="now__band-empty">{emptyHint}</div>
      ) : (
        <ul className="now__rows">{children}</ul>
      )}
    </section>
  );
}

function Row({
  kind,
  primary,
  secondary,
  time,
  routineId,
  reminderId,
  projectName,
  onOpen,
}: {
  kind:
    | 'awaiting'
    | 'running'
    | 'imminent-reminder'
    | 'imminent-inbox'
    | 'errored';
  primary: string;
  secondary?: string;
  time: string;
  routineId?: string | null;
  reminderId?: string | null;
  projectName?: string | null;
  onOpen: () => void;
}) {
  return (
    <li className={`now__row now__row--${kind}`} onClick={onOpen} role="button">
      <span className="now__row-dot" aria-hidden />
      <div className="now__row-body">
        <div className="now__row-primary">{primary}</div>
        {secondary && <div className="now__row-secondary">{secondary}</div>}
        {(routineId || reminderId || projectName) && (
          <div className="now__row-links">
            {projectName && (
              <span className="now__row-link" title="Active project">
                {projectName}
              </span>
            )}
            {routineId && (
              <span className="now__row-link" title="Fired by routine">
                ⟳ {routineId}
              </span>
            )}
            {reminderId && (
              <span className="now__row-link" title="From scheduled reminder">
                ⏰ {reminderId}
              </span>
            )}
          </div>
        )}
      </div>
      <span className="now__row-time">{time}</span>
    </li>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function focusTask(taskId: string): void {
  void window.jarvis.openObservatory(taskId);
}

function navigateTo(tab: string): void {
  window.dispatchEvent(
    new CustomEvent('jarvis:navigate', { detail: { tab } }),
  );
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRel(diffMs: number): string {
  if (diffMs < 60_000) return 'just now';
  const m = Math.round(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function formatCountdown(diffMs: number): string {
  if (diffMs < 60_000) return 'in <1m';
  const m = Math.round(diffMs / 60_000);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}
