import type { Stage } from './types';

/**
 * The static layer of the river — six luminous stage gates spanning
 * the page width, with section labels above each. Renders only once
 * (no state). Orbs sit on top in a sibling SVG layer.
 *
 * Coordinate space: 0–1000 horizontal, 0–600 vertical. The container
 * scales the SVG via preserveAspectRatio so the layout reads on a
 * tablet-narrow window AND on a 4k monitor.
 */

interface StageDef {
  id: Stage;
  label: string;
  x: number;
  /** When true, this is a "side outlet" rather than part of the main
   *  linear flow. Renders below the river. */
  side?: boolean;
}

export const STAGE_DEFS: StageDef[] = [
  { id: 'trigger', label: 'TRIGGER', x: 100 },
  { id: 'intent', label: 'INTENT', x: 240 },
  { id: 'route', label: 'ROUTE', x: 380 },
  { id: 'launch', label: 'LAUNCH', x: 520 },
  { id: 'agent', label: 'AGENT', x: 660 },
  { id: 'result', label: 'RESULT', x: 800 },
  { id: 'notify', label: 'NOTIFY', x: 920, side: true },
];

/** Y center for orbs traveling the main river. */
export const RIVER_Y = 280;
/** Y center for the notify outlet (slightly below the river). */
export const NOTIFY_Y = 430;
/** ±range applied to the orb's Y via jitter for an organic feel. */
export const JITTER_RANGE = 60;

/**
 * X position for a given stage id, used by orbs to position themselves.
 */
export function xForStage(stage: Stage): number {
  return STAGE_DEFS.find((s) => s.id === stage)?.x ?? STAGE_DEFS[0]!.x;
}

/**
 * Y center for a given stage. Notify sits on its own lane so its dots
 * don't crowd the river.
 */
export function yForStage(stage: Stage): number {
  return stage === 'notify' ? NOTIFY_Y : RIVER_Y;
}

export function Pipeline() {
  return (
    <g className="flow-pipeline">
      {/* Faint baseline that traces the river. */}
      <line
        x1={60}
        y1={RIVER_Y}
        x2={STAGE_DEFS[STAGE_DEFS.length - 1]!.x + 40}
        y2={RIVER_Y}
        stroke="rgba(0, 212, 255, 0.18)"
        strokeWidth={1}
        strokeDasharray="2 6"
      />
      {/* Branch line from result → notify. */}
      <line
        x1={800}
        y1={RIVER_Y}
        x2={920}
        y2={NOTIFY_Y}
        stroke="rgba(255, 255, 255, 0.08)"
        strokeWidth={1}
        strokeDasharray="2 6"
      />

      {STAGE_DEFS.map((s) => {
        const y = s.side ? NOTIFY_Y : RIVER_Y;
        return (
          <g
            key={s.id}
            className={`flow-gate flow-gate--${s.id}`}
            data-stage={s.id}
          >
            <rect
              x={s.x - 14}
              y={y - 90}
              width={28}
              height={180}
              rx={2}
              fill="rgba(0, 212, 255, 0.05)"
              stroke="rgba(0, 212, 255, 0.4)"
              strokeWidth={1}
              filter="url(#flow-gate-glow)"
            />
            <text
              x={s.x}
              y={y - 110}
              textAnchor="middle"
              className="flow-gate__label"
            >
              {s.label}
            </text>
          </g>
        );
      })}

      {/* Glow filter shared by gates + orbs. */}
      <defs>
        <filter
          id="flow-gate-glow"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feGaussianBlur stdDeviation={3} />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter
          id="flow-orb-glow"
          x="-100%"
          y="-100%"
          width="300%"
          height="300%"
        >
          <feGaussianBlur stdDeviation={4} />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </g>
  );
}
