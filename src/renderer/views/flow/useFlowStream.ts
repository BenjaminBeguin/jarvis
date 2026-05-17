import { useEffect, useReducer, useRef } from 'react';

import type {
  NotifierEmitPayload,
  Reminder,
  TaskEvent,
  TaskSummary,
} from '../../../shared/types';
import type { FlowEvent, FlowKind, FlowSource, Stage } from './types';

/**
 * Merges several IPC streams into one timeline of FlowEvents.
 *
 * Subscribed channels:
 *   - taskStatus / taskEvent / taskRemoved → derives task orbs and
 *     advances their stage as the SDK reports init / messages / result
 *   - remindersChanged → derives reminder orbs (pending→fired spawns
 *     a new orb at trigger)
 *   - inboxRefreshing + inboxChanged → derives an inbox-scan orb for
 *     the duration of a hard refresh
 *   - notifierEmitted → terminal-stage notification orbs
 *
 * Caps in-memory at MAX_ORBS to keep the SVG layer light. Older entries
 * are pruned as fresh ones come in. Backfilled on mount via the
 * existing list endpoints so the page isn't blank when opened cold.
 */

const MAX_ORBS = 60;
/** Time after a stage reaches `result`/`notify` before the orb fades
 *  off the right edge. */
const GRACE_MS = 30_000;
/** Sweep cadence — runs once per second to advance fade timers and
 *  prune expired orbs. */
const SWEEP_MS = 1000;

interface State {
  events: Map<string, FlowEvent>;
  /** Bumped on every change so the reducer triggers a re-render even
   *  when the Map identity is preserved by intent. */
  rev: number;
}

type Action =
  | { type: 'upsert'; events: FlowEvent[] }
  | { type: 'sweep'; now: number }
  | { type: 'remove'; ids: string[] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'upsert': {
      const next = new Map(state.events);
      for (const e of action.events) {
        const prior = next.get(e.id);
        if (prior) {
          // Don't regress a more-advanced stage. The same task can
          // emit multiple status events; we only move forward.
          const priorIdx = stageIndex(prior.stage);
          const nextIdx = stageIndex(e.stage);
          if (nextIdx < priorIdx) {
            next.set(e.id, { ...prior, status: e.status, label: e.label });
            continue;
          }
          // Append to stageHistory only when the stage actually changed.
          const history =
            e.stage !== prior.stage
              ? [...prior.stageHistory, { stage: e.stage, ts: Date.now() }]
              : prior.stageHistory;
          next.set(e.id, {
            ...prior,
            ...e,
            stageHistory: history,
            // Preserve the jitter computed at insert so the orb doesn't
            // jump vertically every time it advances.
            jitter: prior.jitter,
            enteredAt: prior.enteredAt,
          });
        } else {
          next.set(e.id, e);
        }
      }
      // Prune the oldest if we're over the cap.
      if (next.size > MAX_ORBS) {
        const sorted = [...next.values()].sort(
          (a, b) => b.enteredAt - a.enteredAt,
        );
        const keep = new Map<string, FlowEvent>();
        for (const e of sorted.slice(0, MAX_ORBS)) keep.set(e.id, e);
        return { events: keep, rev: state.rev + 1 };
      }
      return { events: next, rev: state.rev + 1 };
    }
    case 'sweep': {
      const next = new Map(state.events);
      let changed = false;
      for (const [id, e] of next) {
        // Drop orbs whose fade window has passed.
        if (e.fadeAt != null && action.now > e.fadeAt) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? { events: next, rev: state.rev + 1 } : state;
    }
    case 'remove': {
      const next = new Map(state.events);
      for (const id of action.ids) next.delete(id);
      return { events: next, rev: state.rev + 1 };
    }
  }
}

const INITIAL_STATE: State = { events: new Map(), rev: 0 };

function stageIndex(s: Stage): number {
  // notify is intentionally outside the linear progression — it can
  // happen at any time without invalidating other stages. We treat it
  // as "after result" for the regression check.
  const order: Stage[] = [
    'trigger',
    'intent',
    'route',
    'launch',
    'agent',
    'result',
    'notify',
  ];
  return order.indexOf(s);
}

function isTerminalStage(s: Stage): boolean {
  return s === 'result' || s === 'notify';
}

/** Cheap deterministic jitter from a string id so the orb's Y is
 *  stable across re-renders. */
function jitterFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h % 1000) / 1000;
}

function sourceForTask(t: TaskSummary): FlowSource {
  switch (t.origin) {
    case 'palette':
      return 'palette';
    case 'voice':
      return 'voice';
    case 'routine':
      return 'cron';
    case 'api':
      // 'api' is used by Telegram bot AND by module-launched tasks.
      // Default to telegram (dominant case); a future signal on the
      // task could disambiguate.
      return 'telegram';
    case 'external':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function stageForTask(t: TaskSummary): Stage {
  if (t.status === 'completed' || t.status === 'errored' || t.status === 'aborted') {
    return 'result';
  }
  if (t.status === 'running') {
    // Once we have an sdkSessionId the SDK has handshaked and we're in
    // the agent loop. Before that we're still booting (launch).
    return t.sdkSessionId ? 'agent' : 'launch';
  }
  return 'launch';
}

function flowFromTask(t: TaskSummary): FlowEvent {
  const stage = stageForTask(t);
  const id = `task:${t.id}`;
  return {
    id,
    source: sourceForTask(t),
    kind: 'task',
    entityId: t.id,
    label: t.title,
    stage,
    stageHistory: [{ stage, ts: Date.now() }],
    status:
      t.status === 'completed'
        ? 'completed'
        : t.status === 'errored'
          ? 'errored'
          : t.status === 'aborted'
            ? 'aborted'
            : 'in-flight',
    enteredAt: t.startedAt ?? Date.now(),
    fadeAt: isTerminalStage(stage) ? Date.now() + GRACE_MS : null,
    jitter: jitterFromId(id),
  };
}

function flowFromReminderFire(r: Reminder): FlowEvent {
  const id = `reminder:${r.id}`;
  const stage: Stage = r.mode === 'scheduled' ? 'route' : 'notify';
  return {
    id,
    source: 'reminder',
    kind: 'reminder',
    entityId: r.id,
    label: r.body,
    stage,
    stageHistory: [{ stage, ts: Date.now() }],
    status: 'completed',
    enteredAt: r.firedAt ?? Date.now(),
    fadeAt: Date.now() + GRACE_MS,
    jitter: jitterFromId(id),
  };
}

function flowFromNotifier(n: NotifierEmitPayload): FlowEvent {
  // Use ts + source so repeated identical sources don't collapse into
  // one orb (each fire is its own event).
  const id = `notif:${n.source}:${n.ts}`;
  return {
    id,
    source: 'notifier',
    kind: 'notification',
    entityId: n.taskId ?? n.reminderId ?? n.source,
    label: `${n.title}${n.body ? ` · ${n.body}` : ''}`,
    stage: 'notify',
    stageHistory: [{ stage: 'notify', ts: n.ts }],
    status: 'completed',
    enteredAt: n.ts,
    fadeAt: n.ts + GRACE_MS,
    jitter: jitterFromId(id),
  };
}

function flowFromInboxScan(active: boolean): FlowEvent | null {
  if (!active) return null;
  const id = `inbox:scan`;
  return {
    id,
    source: 'module',
    kind: 'inbox-scan',
    entityId: 'inbox',
    label: 'Inbox refresh',
    stage: 'agent',
    stageHistory: [{ stage: 'agent', ts: Date.now() }],
    status: 'in-flight',
    enteredAt: Date.now(),
    fadeAt: null,
    jitter: jitterFromId(id),
  };
}

export function useFlowStream(): FlowEvent[] {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  // Remember reminder pending → fired transitions so we don't re-spawn
  // the orb every time the reminders list re-broadcasts.
  const seenFiredRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    // Backfill: recent tasks + reminders so the page isn't blank.
    void window.jarvis.listTasks().then((tasks) => {
      if (cancelled) return;
      const recent = tasks
        .filter((t) => t.origin !== 'external')
        .slice(0, 20)
        .map(flowFromTask);
      if (recent.length) dispatch({ type: 'upsert', events: recent });
    });
    void window.jarvis.listReminders().then((rems) => {
      if (cancelled) return;
      for (const r of rems) {
        if (r.status === 'fired' && r.firedAt) {
          seenFiredRef.current.add(r.id);
          dispatch({ type: 'upsert', events: [flowFromReminderFire(r)] });
        }
      }
    });

    const offStatus = window.jarvis.onTaskStatus((t: TaskSummary) => {
      if (t.origin === 'external') return;
      dispatch({ type: 'upsert', events: [flowFromTask(t)] });
    });

    const offEvent = window.jarvis.onTaskEvent((p: {
      taskId: string;
      event: TaskEvent;
    }) => {
      // Use the first SDK init/assistant message as the signal to
      // advance the orb from `launch` → `agent`. Other events don't
      // need handling here — taskStatus carries enough info already.
      const msg = p.event.msg as { type?: string } | undefined;
      if (msg?.type !== 'system' && msg?.type !== 'assistant') return;
      // We can't synthesize a full FlowEvent without the TaskSummary,
      // so we trust that a taskStatus broadcast will follow with the
      // sdkSessionId set. This branch is a no-op in v1 — kept here so
      // the wiring exists for refining stage transitions later if the
      // status-only path misses moments.
    });

    const offRemoved = window.jarvis.onTaskRemoved((taskId: string) => {
      dispatch({ type: 'remove', ids: [`task:${taskId}`] });
    });

    const offReminders = window.jarvis.onRemindersChanged((rems: Reminder[]) => {
      const fresh: FlowEvent[] = [];
      const stillFired = new Set<string>();
      for (const r of rems) {
        if (r.status === 'fired') {
          stillFired.add(r.id);
          if (!seenFiredRef.current.has(r.id)) {
            seenFiredRef.current.add(r.id);
            fresh.push(flowFromReminderFire(r));
          }
        }
      }
      // Drop ids that are no longer in the fired set (snoozed,
      // cancelled) so future re-fires re-spawn the orb.
      for (const id of seenFiredRef.current) {
        if (!stillFired.has(id)) seenFiredRef.current.delete(id);
      }
      if (fresh.length) dispatch({ type: 'upsert', events: fresh });
    });

    const offRefreshing = window.jarvis.onInboxRefreshing((active: boolean) => {
      const event = flowFromInboxScan(active);
      if (active && event) {
        dispatch({ type: 'upsert', events: [event] });
      } else {
        // Sweep the inbox-scan orb into terminal state when refresh ends.
        dispatch({
          type: 'upsert',
          events: [
            {
              id: 'inbox:scan',
              source: 'module',
              kind: 'inbox-scan',
              entityId: 'inbox',
              label: 'Inbox refresh',
              stage: 'result',
              stageHistory: [{ stage: 'result', ts: Date.now() }],
              status: 'completed',
              enteredAt: Date.now(),
              fadeAt: Date.now() + GRACE_MS,
              jitter: jitterFromId('inbox:scan'),
            },
          ],
        });
      }
    });

    const offNotifier = window.jarvis.onNotifierEmitted(
      (n: NotifierEmitPayload) => {
        dispatch({ type: 'upsert', events: [flowFromNotifier(n)] });
      },
    );

    const sweepHandle = window.setInterval(() => {
      dispatch({ type: 'sweep', now: Date.now() });
    }, SWEEP_MS);

    return () => {
      cancelled = true;
      offStatus();
      offEvent();
      offRemoved();
      offReminders();
      offRefreshing();
      offNotifier();
      window.clearInterval(sweepHandle);
    };
  }, []);

  // Return as array sorted by enteredAt (newest first) — the render
  // layer doesn't actually need this order, but it keeps React's
  // key-based reconciliation stable.
  return [...state.events.values()].sort((a, b) => a.enteredAt - b.enteredAt);
}
