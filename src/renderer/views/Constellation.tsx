import { useMemo } from 'react';

import type { Reminder, TaskSummary } from '../../shared/types';

/* The SVG lives in a 1000×1000 viewBox; coordinates below are in that space. */
const CENTER = { x: 500, y: 500 };
const CORE_RADIUS = 56;
const RING_RADIUS = 260;
const REMINDER_RING_RADIUS = 360;
const MAX_NODES = 12;
const MAX_REMINDERS = 8;
/** External sessions that ended within this window still show as faded nodes. */
const RECENCY_MS = 30 * 60 * 1000;
/** Pulsing "you just launched this" focus ring lifetime. */
const FOCUS_WINDOW_MS = 60 * 1000;

interface NodePos {
  task: TaskSummary;
  x: number;
  y: number;
  angle: number;
  isLive: boolean;
}

function lastActivityAt(task: TaskSummary): number {
  if (task.status === 'running') return Date.now();
  return task.endedAt ?? task.startedAt;
}

function shouldDisplay(task: TaskSummary): boolean {
  if (task.status === 'running') return true;
  if (task.origin !== 'external') return false;
  const ended = task.endedAt ?? 0;
  return Date.now() - ended < RECENCY_MS;
}

function layoutRing(tasks: TaskSummary[]): NodePos[] {
  const n = Math.max(1, tasks.length);
  return tasks.map((task, i) => {
    // Start at top (-90°) so the first node sits above the core.
    const angle = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    return {
      task,
      angle,
      x: CENTER.x + Math.cos(angle) * RING_RADIUS,
      y: CENTER.y + Math.sin(angle) * RING_RADIUS,
      isLive: task.status === 'running',
    };
  });
}

function nodeLabel(task: TaskSummary): string {
  // Trim "<project> · " prefix the watcher prepends to give shorter labels.
  const cleaned = task.title.replace(/^[^·]+·\s*/, '').trim();
  const short = cleaned || task.title;
  return short.length > 28 ? `${short.slice(0, 27)}…` : short;
}

function nodeGroup(task: TaskSummary): string {
  if (task.origin === 'external') return 'agent';
  if (task.origin === 'routine') return 'routine';
  return 'task';
}

interface ReminderNodePos {
  reminder: Reminder;
  x: number;
  y: number;
  angle: number;
}

function layoutReminderRing(reminders: Reminder[]): ReminderNodePos[] {
  const n = Math.max(1, reminders.length);
  return reminders.map((reminder, i) => {
    // Offset by half a step from the task ring so reminder + task nodes don't
    // overlap when the constellation is light.
    const step = (2 * Math.PI) / n;
    const angle = -Math.PI / 2 + step / 2 + i * step;
    return {
      reminder,
      angle,
      x: CENTER.x + Math.cos(angle) * REMINDER_RING_RADIUS,
      y: CENTER.y + Math.sin(angle) * REMINDER_RING_RADIUS,
    };
  });
}

function fireCountdown(fireAt: number, now: number): string {
  const diff = fireAt - now;
  if (diff <= 0) return 'now';
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function reminderLabel(r: Reminder, now: number): string {
  const head = r.body.length > 24 ? `${r.body.slice(0, 23)}…` : r.body;
  return `${head}  ·  ${fireCountdown(r.fireAt, now)}`;
}

interface Props {
  tasks: TaskSummary[];
  reminders: Reminder[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCancelReminder?: (id: string) => void;
}

export function Constellation({
  tasks,
  reminders,
  selectedId,
  onSelect,
  onCancelReminder,
}: Props) {
  const visible = useMemo(
    () =>
      tasks
        .filter(shouldDisplay)
        .sort((a, b) => lastActivityAt(b) - lastActivityAt(a))
        .slice(0, MAX_NODES),
    [tasks],
  );

  const positions = useMemo(() => layoutRing(visible), [visible]);
  const liveCount = visible.filter((t) => t.status === 'running').length;
  const recentCount = visible.length - liveCount;
  const awaitingCount = visible.filter((t) => t.awaitingInput).length;
  const overflow = Math.max(0, tasks.filter(shouldDisplay).length - MAX_NODES);

  const visibleReminders = useMemo(
    () =>
      reminders
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.fireAt - b.fireAt)
        .slice(0, MAX_REMINDERS),
    [reminders],
  );
  const reminderPositions = useMemo(
    () => layoutReminderRing(visibleReminders),
    [visibleReminders],
  );
  const now = Date.now();

  // Most-recently-launched Jarvis-owned task within the focus window —
  // gets a pulsing ring so the user can find what they just kicked off.
  const focusId = useMemo<string | null>(() => {
    const now = Date.now();
    const candidates = visible
      .filter(
        (t) =>
          t.origin !== 'external' &&
          now - t.startedAt < FOCUS_WINDOW_MS,
      )
      .sort((a, b) => b.startedAt - a.startedAt);
    return candidates[0]?.id ?? null;
  }, [visible]);

  // Connection edges between same-group nodes used to draw here, but with
  // claude-code-watch the only producer of groupKey, "same project"
  // meshed every node together for no useful signal. Drop until we have
  // real parent/child task relationships to render.

  return (
    <div
      className="constellation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
    >
      <svg
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid meet"
        className="constellation__svg"
        onClick={() => onSelect(null)}
      >
        <defs>
          <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,212,255,0.65)" />
            <stop offset="60%" stopColor="rgba(0,212,255,0.08)" />
            <stop offset="100%" stopColor="rgba(0,212,255,0)" />
          </radialGradient>
          <radialGradient id="node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,212,255,0.5)" />
            <stop offset="100%" stopColor="rgba(0,212,255,0)" />
          </radialGradient>
          <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* Ambient starfield — pure decoration. */}
        <g className="constellation__stars">
          {STAR_POSITIONS.map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} />
          ))}
        </g>

        {/* Outer orbital rings — slow rotation. */}
        <g className="constellation__rings">
          <circle cx={CENTER.x} cy={CENTER.y} r={140} className="ring ring--inner" />
          <circle cx={CENTER.x} cy={CENTER.y} r={RING_RADIUS} className="ring ring--main" />
          <circle cx={CENTER.x} cy={CENTER.y} r={340} className="ring ring--outer" />
        </g>

        {/* Spokes from core to each node. */}
        <g className="constellation__spokes">
          {positions.map((p) => (
            <line
              key={`spoke-${p.task.id}`}
              x1={CENTER.x + Math.cos(p.angle) * CORE_RADIUS}
              y1={CENTER.y + Math.sin(p.angle) * CORE_RADIUS}
              x2={p.x}
              y2={p.y}
              className={`spoke${selectedId === p.task.id ? ' spoke--selected' : ''}`}
            />
          ))}
        </g>


        {/* Central core. */}
        <g className="core">
          <circle cx={CENTER.x} cy={CENTER.y} r={120} fill="url(#core-glow)" />
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={CORE_RADIUS + 14}
            className="core__halo"
          />
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={CORE_RADIUS}
            className="core__disc"
          />
          {/* Two short crosshair ticks for a reticle feel. */}
          <line
            x1={CENTER.x - CORE_RADIUS - 16}
            y1={CENTER.y}
            x2={CENTER.x - CORE_RADIUS - 4}
            y2={CENTER.y}
            className="core__tick"
          />
          <line
            x1={CENTER.x + CORE_RADIUS + 4}
            y1={CENTER.y}
            x2={CENTER.x + CORE_RADIUS + 16}
            y2={CENTER.y}
            className="core__tick"
          />
          <text
            x={CENTER.x}
            y={CENTER.y - 4}
            className="core__label"
            textAnchor="middle"
          >
            JARVIS
          </text>
          <text
            x={CENTER.x}
            y={CENTER.y + 18}
            className="core__count"
            textAnchor="middle"
          >
            {liveCount} LIVE{recentCount ? ` · ${recentCount} RECENT` : ''}
          </text>
          {awaitingCount > 0 && (
            <text
              x={CENTER.x}
              y={CENTER.y + 36}
              className="core__awaiting"
              textAnchor="middle"
            >
              {awaitingCount} AWAITING REPLY
            </text>
          )}
        </g>

        {/* Nodes (agents). */}
        <g className="constellation__nodes">
          {positions.map((p) => {
            const isSelected = selectedId === p.task.id;
            const group = nodeGroup(p.task);
            const label = nodeLabel(p.task);
            // Tangent direction so labels read along the ring.
            const labelOffset = 30;
            const lx = CENTER.x + Math.cos(p.angle) * (RING_RADIUS + labelOffset);
            const ly = CENTER.y + Math.sin(p.angle) * (RING_RADIUS + labelOffset);
            const textAnchor =
              Math.cos(p.angle) > 0.2 ? 'start' : Math.cos(p.angle) < -0.2 ? 'end' : 'middle';
            const awaiting = !!p.task.awaitingInput;
            const isFocus = p.task.id === focusId;
            return (
              <g
                key={p.task.id}
                className={`node node--${group}${p.isLive ? '' : ' node--idle'}${awaiting ? ' node--awaiting' : ''}${isSelected ? ' node--selected' : ''}${isFocus ? ' node--focus' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(p.task.id);
                }}
              >
                {isFocus && (
                  <>
                    <circle cx={p.x} cy={p.y} r={22} className="node__focus-ring node__focus-ring--inner" />
                    <circle cx={p.x} cy={p.y} r={22} className="node__focus-ring node__focus-ring--outer" />
                  </>
                )}
                <circle cx={p.x} cy={p.y} r={30} fill="url(#node-glow)" />
                <circle cx={p.x} cy={p.y} r={isSelected ? 14 : 10} className="node__disc" />
                <circle cx={p.x} cy={p.y} r={5} className="node__pulse" />
                {awaiting && (
                  <g className="node__awaiting-mark">
                    <circle
                      cx={p.x + 16}
                      cy={p.y - 16}
                      r={7}
                      className="node__awaiting-bg"
                    />
                    <text
                      x={p.x + 16}
                      y={p.y - 16}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="node__awaiting-glyph"
                    >
                      !
                    </text>
                  </g>
                )}
                <text
                  x={lx}
                  y={ly}
                  className="node__label"
                  textAnchor={textAnchor}
                  dominantBaseline="middle"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>

        {/* Pending reminders, outer orbit. Click to cancel. */}
        <g className="constellation__reminders">
          {reminderPositions.map((p) => {
            const label = reminderLabel(p.reminder, now);
            const labelOffset = 26;
            const lx = CENTER.x + Math.cos(p.angle) * (REMINDER_RING_RADIUS + labelOffset);
            const ly = CENTER.y + Math.sin(p.angle) * (REMINDER_RING_RADIUS + labelOffset);
            const textAnchor =
              Math.cos(p.angle) > 0.2 ? 'start' : Math.cos(p.angle) < -0.2 ? 'end' : 'middle';
            return (
              <g
                key={`rem-${p.reminder.id}`}
                className="reminder-node"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onCancelReminder && confirm(`Cancel reminder: "${p.reminder.body}"?`)) {
                    onCancelReminder(p.reminder.id);
                  }
                }}
              >
                <circle cx={p.x} cy={p.y} r={7} className="reminder-node__disc" />
                <circle cx={p.x} cy={p.y} r={3} className="reminder-node__dot" />
                <text
                  x={lx}
                  y={ly}
                  className="reminder-node__label"
                  textAnchor={textAnchor}
                  dominantBaseline="middle"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>

        {overflow > 0 && (
          <text
            x={CENTER.x}
            y={970}
            className="constellation__overflow"
            textAnchor="middle"
          >
            + {overflow} MORE OFF-CONSTELLATION
          </text>
        )}

        {visible.length === 0 && (
          <text
            x={CENTER.x}
            y={780}
            className="constellation__standby"
            textAnchor="middle"
          >
            STANDBY · ⌘⇧J TO DEPLOY
          </text>
        )}
      </svg>
    </div>
  );
}

/* Hand-picked star positions so the field isn't perfectly uniform.
   Generated once; no randomness on every render. */
const STAR_POSITIONS: Array<[number, number, number]> = [
  [82, 124, 1], [180, 60, 0.6], [310, 188, 1], [60, 280, 0.8],
  [410, 90, 1], [560, 60, 0.6], [690, 130, 1], [820, 80, 0.8],
  [930, 200, 1], [880, 320, 0.6], [950, 470, 1], [780, 540, 0.8],
  [620, 920, 1], [490, 970, 0.6], [320, 920, 1], [180, 880, 0.8],
  [80, 760, 1], [40, 600, 0.6], [120, 460, 1], [40, 920, 0.8],
  [880, 760, 1], [930, 850, 0.6], [780, 920, 1], [220, 240, 0.4],
  [740, 250, 0.4], [320, 720, 0.4], [680, 720, 0.4],
];
