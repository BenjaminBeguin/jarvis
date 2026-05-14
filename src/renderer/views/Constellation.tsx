import { useEffect, useMemo, useRef, useState } from 'react';

import type { JarvisFileEntry, Reminder, TaskSummary } from '../../shared/types';
import type { MeetingState } from '../voice/MeetingRecorder';
import { useNow } from './useNow';

/* The SVG lives in a 1000×1000 viewBox; coordinates below are in that space. */
const CENTER = { x: 500, y: 500 };
const CORE_RADIUS = 56;
const RING_RADIUS = 260;
const REMINDER_RING_RADIUS = 360;
const ARTIFACT_RING_RADIUS = 440;
const MAX_NODES = 18;
const MAX_REMINDERS = 8;
const MAX_ARTIFACTS = 10;
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
  const tag = r.mode === 'scheduled' ? '⚡' : '⏰';
  return `${tag} ${head}  ·  ${fireCountdown(r.fireAt, now)}`;
}

/**
 * "Artifacts" = quick-jot evidence that work is happening — recent notes
 * and recent meetings. They sit on the outer-outer orbit as tiny dots with
 * a glyph + short label, so the brain view shows everything the user
 * touched recently, not just what's running right now.
 */
type Artifact =
  | { kind: 'note'; name: string; mtimeMs: number }
  | { kind: 'meeting'; name: string; mtimeMs: number };

interface ArtifactNodePos {
  artifact: Artifact;
  x: number;
  y: number;
  angle: number;
}

function layoutArtifactRing(arts: Artifact[]): ArtifactNodePos[] {
  const n = Math.max(1, arts.length);
  return arts.map((artifact, i) => {
    const step = (2 * Math.PI) / n;
    // Offset so artifact ring doesn't perfectly align with the reminder ring.
    const angle = -Math.PI / 2 + step / 3 + i * step;
    return {
      artifact,
      angle,
      x: CENTER.x + Math.cos(angle) * ARTIFACT_RING_RADIUS,
      y: CENTER.y + Math.sin(angle) * ARTIFACT_RING_RADIUS,
    };
  });
}

function artifactLabel(a: Artifact): string {
  const tag = a.kind === 'note' ? '✎' : '🎙';
  const head = a.name.replace(/\.md$/, '').replace(/^[\d-T]+(-)/, '');
  const trimmed = head.length > 20 ? `${head.slice(0, 19)}…` : head;
  return `${tag} ${trimmed}`;
}

interface Props {
  tasks: TaskSummary[];
  reminders: Reminder[];
  /** Recent note files (mtime-sorted desc, capped by caller). */
  recentNotes?: JarvisFileEntry[];
  /** Recent meeting files (mtime-sorted desc, capped by caller). */
  recentMeetings?: JarvisFileEntry[];
  /** Live meeting recorder state — pulses a RECORDING node when active. */
  meetingState?: MeetingState;
  /** Pending skill-suggester proposals — shows a count line on the core. */
  pendingSuggestionCount?: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCancelReminder?: (id: string) => void;
  onFireReminderNow?: (id: string) => void;
}

export function Constellation({
  tasks,
  reminders,
  recentNotes = [],
  recentMeetings = [],
  meetingState,
  pendingSuggestionCount = 0,
  selectedId,
  onSelect,
  onCancelReminder,
  onFireReminderNow,
}: Props) {
  /** Action menu state for reminder/scheduled nodes. */
  const [reminderMenu, setReminderMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);

  /** Pan + zoom transform on the SVG viewport. Scroll = zoom, drag = pan. */
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);

  /**
   * Figma-style trackpad behavior:
   *   - Pinch (wheel + ctrlKey, which is what macOS synthesizes for
   *     pinch gestures on the trackpad) → zoom anchored at the cursor.
   *   - Two-finger scroll → pan the canvas.
   *   - Regular mouse wheel (deltaMode 1, no ctrlKey) → also zoom,
   *     since users without trackpads expect wheel = zoom on a map view.
   * Clamp scale to a friendly range so it can't go wild.
   */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const isPinch = e.ctrlKey;
      const isMouseWheel = e.deltaMode === 1 || Math.abs(e.deltaY) > 50;
      const shouldZoom = isPinch || isMouseWheel;

      if (shouldZoom) {
        // Larger sensitivity for pinch (deltaY is small for trackpad
        // gestures); modest for mouse wheel.
        const k = isPinch ? 0.02 : 0.005;
        const factor = Math.exp(-e.deltaY * k);
        // Mouse in viewBox-space.
        const vx = ((e.clientX - rect.left) / rect.width) * 1000;
        const vy = ((e.clientY - rect.top) / rect.height) * 1000;
        setView((v) => {
          const next = Math.max(0.3, Math.min(5, v.scale * factor));
          if (next === v.scale) return v;
          const r = next / v.scale;
          return {
            scale: next,
            tx: vx - (vx - v.tx) * r,
            ty: vy - (vy - v.ty) * r,
          };
        });
      } else {
        // Two-finger scroll on a trackpad → pan. Translate the wheel
        // delta (pixels) into viewBox units.
        const dx = (e.deltaX / rect.width) * 1000;
        const dy = (e.deltaY / rect.height) * 1000;
        setView((v) => ({ ...v, tx: v.tx - dx, ty: v.ty - dy }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPanStart = (e: React.MouseEvent) => {
    // Only pan when dragging on empty space (background click, not on a node).
    if (e.target !== e.currentTarget && !(e.target as Element).classList?.contains('constellation__pan-bg')) {
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      tx: view.tx,
      ty: view.ty,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const start = panRef.current;
      if (!start) return;
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Convert pixel delta → viewBox delta.
      const dx = ((e.clientX - start.startX) / rect.width) * 1000;
      const dy = ((e.clientY - start.startY) / rect.height) * 1000;
      setView((v) => ({ ...v, tx: start.tx + dx, ty: start.ty + dy }));
    };
    const onUp = () => {
      panRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const resetView = () => setView({ scale: 1, tx: 0, ty: 0 });

  // Close the menu on any outside click or Escape.
  useEffect(() => {
    if (!reminderMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReminderMenu(null);
    };
    const onClick = () => setReminderMenu(null);
    window.addEventListener('keydown', onKey);
    // Defer so the same click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener('click', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(t);
      window.removeEventListener('click', onClick);
    };
  }, [reminderMenu]);
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

  // Recent notes + meetings on the outer-outer orbit. Merged + sorted so the
  // freshest sit closer to the start (top).
  const visibleArtifacts = useMemo<Artifact[]>(() => {
    const merged: Artifact[] = [
      ...recentNotes.map(
        (n): Artifact => ({ kind: 'note', name: n.name, mtimeMs: n.mtimeMs }),
      ),
      ...recentMeetings.map(
        (m): Artifact => ({ kind: 'meeting', name: m.name, mtimeMs: m.mtimeMs }),
      ),
    ];
    return merged
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_ARTIFACTS);
  }, [recentNotes, recentMeetings]);
  const artifactPositions = useMemo(
    () => layoutArtifactRing(visibleArtifacts),
    [visibleArtifacts],
  );

  // 30s tick so '· 18m' countdowns stay roughly fresh without per-frame work.
  const now = useNow(30_000);

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
        ref={svgRef}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid meet"
        className={`constellation__svg${panRef.current ? ' constellation__svg--panning' : ''}`}
        onMouseDown={onPanStart}
        onDoubleClick={(e) => {
          // Reset view only when the user double-clicks empty space (not a
          // node or the core).
          if (
            e.target === e.currentTarget ||
            (e.target as Element).classList?.contains('constellation__pan-bg')
          ) {
            resetView();
          }
        }}
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

        {/* Pan-catcher background — transparent, full viewport. Picks up
            drag events on empty space so the user can pan the whole map
            without having to find an exact pixel gap between rings. */}
        <rect
          x={-2000}
          y={-2000}
          width={5000}
          height={5000}
          fill="transparent"
          className="constellation__pan-bg"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(null);
          }}
        />

        {/* Everything below is wrapped in the pan/zoom transform group. */}
        <g
          transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}
          style={{ transformOrigin: '0 0' }}
        >

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
          {visibleReminders.length > 0 && (
            <text
              x={CENTER.x}
              y={CENTER.y + (awaitingCount > 0 ? 52 : 36)}
              className="core__scheduled"
              textAnchor="middle"
            >
              {visibleReminders.length} SCHEDULED
            </text>
          )}
          {pendingSuggestionCount > 0 && (
            <text
              x={CENTER.x}
              y={
                CENTER.y +
                (awaitingCount > 0 ? 68 : 52) +
                (visibleReminders.length > 0 ? 0 : -16)
              }
              className="core__suggestions"
              textAnchor="middle"
            >
              {pendingSuggestionCount} SKILL IDEA{pendingSuggestionCount === 1 ? '' : 'S'}
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

        {/* Active meeting recording — sits between the core and the task
            ring, pulsing red so it can't be missed. Only rendered while
            audio is actively being captured. */}
        {meetingState?.active && (
          <g className="recording-node">
            <circle cx={CENTER.x} cy={CENTER.y - 170} r={24} className="recording-node__halo" />
            <circle cx={CENTER.x} cy={CENTER.y - 170} r={9} className="recording-node__disc" />
            <text
              x={CENTER.x}
              y={CENTER.y - 195}
              textAnchor="middle"
              className="recording-node__label"
            >
              ● REC{meetingState.title ? ` · ${meetingState.title.slice(0, 22)}` : ''}
            </text>
          </g>
        )}

        {/* Recent notes + meetings — outer-outer orbit. Subtle, not
            clickable, just shows "things the user touched recently". */}
        <g className="constellation__artifacts">
          {artifactPositions.map((p) => {
            const labelOffset = 22;
            const lx = CENTER.x + Math.cos(p.angle) * (ARTIFACT_RING_RADIUS + labelOffset);
            const ly = CENTER.y + Math.sin(p.angle) * (ARTIFACT_RING_RADIUS + labelOffset);
            const textAnchor =
              Math.cos(p.angle) > 0.2 ? 'start' : Math.cos(p.angle) < -0.2 ? 'end' : 'middle';
            return (
              <g
                key={`art-${p.artifact.kind}-${p.artifact.name}`}
                className={`artifact-node artifact-node--${p.artifact.kind}`}
              >
                <circle cx={p.x} cy={p.y} r={3} className="artifact-node__dot" />
                <text
                  x={lx}
                  y={ly}
                  textAnchor={textAnchor}
                  dominantBaseline="middle"
                  className="artifact-node__label"
                >
                  {artifactLabel(p.artifact)}
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
                  setReminderMenu({ id: p.reminder.id, x: p.x, y: p.y });
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

        {/* Reminder action menu (Run now / Cancel). Rendered as HTML
            inside the SVG via foreignObject so buttons can hit-test
            normally. Positioned slightly right + below the node. */}
        {reminderMenu && (() => {
          const r = reminders.find((x) => x.id === reminderMenu.id);
          if (!r) return null;
          const menuW = 200;
          const menuH = 96;
          // Clamp to viewBox so the menu doesn't fall off-screen.
          const fx = Math.min(1000 - menuW - 8, reminderMenu.x + 12);
          const fy = Math.min(1000 - menuH - 8, reminderMenu.y + 12);
          return (
            <foreignObject
              x={fx}
              y={fy}
              width={menuW}
              height={menuH}
              className="reminder-menu-host"
            >
              <div
                className="reminder-menu"
                // Stop the outer "any click closes" handler from firing on
                // the menu itself; only outside clicks should dismiss.
                onClick={(e) => e.stopPropagation()}
              >
                <div className="reminder-menu__title">
                  {r.mode === 'scheduled' ? '⚡ scheduled' : '⏰ reminder'}
                </div>
                <button
                  className="reminder-menu__btn reminder-menu__btn--primary"
                  onClick={() => {
                    onFireReminderNow?.(r.id);
                    setReminderMenu(null);
                  }}
                >
                  ▶ Run now
                </button>
                <button
                  className="reminder-menu__btn"
                  onClick={() => {
                    onCancelReminder?.(r.id);
                    setReminderMenu(null);
                  }}
                >
                  × Cancel
                </button>
              </div>
            </foreignObject>
          );
        })()}

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
        </g>{/* end pan/zoom transform group */}
      </svg>
      <div className="constellation__controls">
        <button
          onClick={() => setView((v) => ({ ...v, scale: Math.max(0.4, v.scale / 1.2) }))}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          onClick={resetView}
          title="Reset view (or double-click empty space)"
          aria-label="Reset"
          className="constellation__controls-reset"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button
          onClick={() => setView((v) => ({ ...v, scale: Math.min(4, v.scale * 1.2) }))}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
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
