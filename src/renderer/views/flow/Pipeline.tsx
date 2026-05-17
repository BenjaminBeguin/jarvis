import type { Stage } from './types';

/**
 * The static (well — *ambient*) layer of the river. Replaces the v1
 * rectangular gates with something less boxy:
 *
 *   - A wavy `<path>` baseline traces the river, animated as a flowing
 *     current via `stroke-dashoffset` so dashes drift continuously
 *     right. Feels alive even when no events are in flight.
 *   - Each stage is a pillar of light — a thin vertical line with a
 *     soft halo + a small node circle on the river — not a bordered
 *     rectangle. Reads more "energy beam" than "form field."
 *   - A few ambient sparkles (small dim dots) drift along the river
 *     constantly. The page never looks dead.
 *
 * Coordinate space: 0–1000 horizontal, 0–600 vertical. The container
 * scales the SVG via preserveAspectRatio so it works on tablet-narrow
 * AND 4k.
 */

interface StageDef {
  id: Stage;
  label: string;
  x: number;
  /** Side outlet (notify) sits below the river. */
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

export const RIVER_Y = 280;
export const NOTIFY_Y = 430;
export const JITTER_RANGE = 60;

export function xForStage(stage: Stage): number {
  return STAGE_DEFS.find((s) => s.id === stage)?.x ?? STAGE_DEFS[0]!.x;
}

export function yForStage(stage: Stage): number {
  return stage === 'notify' ? NOTIFY_Y : RIVER_Y;
}

/**
 * A wavy SVG path. Sine-style undulation across the full width, with
 * three control points so it has multiple soft crests. The shape is
 * static — motion comes from the dashes drifting along it.
 */
const RIVER_PATH = (() => {
  const startX = 60;
  const endX = 860; // stops just before the notify branch
  const amplitude = 8;
  // Three crests across the width.
  const c1 = `${startX + 200},${RIVER_Y - amplitude * 2}`;
  const c2 = `${startX + 400},${RIVER_Y + amplitude * 2}`;
  const mid = `${startX + 400},${RIVER_Y}`;
  const c3 = `${startX + 500},${RIVER_Y - amplitude * 2}`;
  const c4 = `${startX + 750},${RIVER_Y + amplitude * 2}`;
  return `M${startX},${RIVER_Y} C${c1} ${c2} ${mid} S${c4} ${endX},${RIVER_Y}` +
    ` C${c3} ${c4} ${endX},${RIVER_Y}`;
})();

/** The branch from RESULT down to NOTIFY — gentle curve. */
const NOTIFY_BRANCH = `M800,${RIVER_Y} C840,${RIVER_Y} 880,${NOTIFY_Y} 920,${NOTIFY_Y}`;

export function Pipeline() {
  return (
    <g className="flow-pipeline">
      {/* Glow filter defs — used by gates AND orbs. */}
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
        <filter
          id="flow-pillar-glow"
          x="-200%"
          y="-50%"
          width="500%"
          height="200%"
        >
          <feGaussianBlur stdDeviation={5} />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="flow-pillar-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(0, 212, 255, 0)" />
          <stop offset="50%" stopColor="rgba(0, 212, 255, 0.7)" />
          <stop offset="100%" stopColor="rgba(0, 212, 255, 0)" />
        </linearGradient>
      </defs>

      {/* Wavy river baseline — dashes drift right continuously via
          CSS keyframes on stroke-dashoffset. */}
      <path
        d={RIVER_PATH}
        fill="none"
        stroke="rgba(0, 212, 255, 0.22)"
        strokeWidth={1.25}
        strokeDasharray="3 9"
        className="flow-river"
      />

      {/* Notify branch — gentler dash so it reads as a secondary
          channel. */}
      <path
        d={NOTIFY_BRANCH}
        fill="none"
        stroke="rgba(255, 255, 255, 0.12)"
        strokeWidth={1}
        strokeDasharray="2 8"
        className="flow-river flow-river--branch"
      />

      {STAGE_DEFS.map((s) => {
        const y = s.side ? NOTIFY_Y : RIVER_Y;
        return (
          <g key={s.id} className={`flow-gate flow-gate--${s.id}`}>
            {/* Portal — three concentric vertical ellipses + a bright
                center slit. Reads as an opening "waiting for something
                to pass through" rather than a button/box. Each ring
                pulses at a different rate so the portal shimmers
                without ever standing still. */}
            <ellipse
              cx={s.x}
              cy={y}
              rx={12}
              ry={56}
              fill="none"
              stroke="rgba(0, 212, 255, 0.18)"
              strokeWidth={1}
              filter="url(#flow-pillar-glow)"
              className="flow-portal flow-portal--outer"
            />
            <ellipse
              cx={s.x}
              cy={y}
              rx={7}
              ry={50}
              fill="none"
              stroke="rgba(0, 212, 255, 0.34)"
              strokeWidth={1}
              filter="url(#flow-pillar-glow)"
              className="flow-portal flow-portal--mid"
            />
            <ellipse
              cx={s.x}
              cy={y}
              rx={3.5}
              ry={44}
              fill="rgba(0, 212, 255, 0.05)"
              stroke="rgba(0, 212, 255, 0.6)"
              strokeWidth={1.25}
              filter="url(#flow-pillar-glow)"
              className="flow-portal flow-portal--inner"
            />
            {/* Bright vertical slit at the portal's core — energy
                shimmer scrolling along its length via dashoffset. */}
            <line
              x1={s.x}
              y1={y - 40}
              x2={s.x}
              y2={y + 40}
              stroke="rgba(180, 240, 255, 0.7)"
              strokeWidth={0.8}
              strokeDasharray="2 5"
              className="flow-portal__slit"
            />
            {/* Label floats above the portal. */}
            <text
              x={s.x}
              y={y - 76}
              textAnchor="middle"
              className="flow-gate__label"
            >
              {s.label}
            </text>
          </g>
        );
      })}

      {/* Ambient sparkles — a few tiny dim dots drifting along the
          river in a loop. Pure decoration; gives the page motion even
          when no real events are in flight. Different delays/durations
          so they don't all line up. */}
      <g className="flow-sparkles" aria-hidden="true">
        {SPARKLE_DEFS.map((s, i) => (
          <circle
            key={i}
            r={1.6}
            fill="rgba(0, 212, 255, 0.55)"
            className="flow-sparkle"
            style={{
              animationDelay: `${s.delay}s`,
              animationDuration: `${s.duration}s`,
              // CSS custom prop drives the y-offset for each sparkle
              ['--sparkle-y' as string]: `${s.y}px`,
            }}
          />
        ))}
      </g>
    </g>
  );
}

/** Ambient sparkle config — staggered for organic feel. */
const SPARKLE_DEFS = [
  { delay: 0, duration: 9, y: -16 },
  { delay: 1.4, duration: 11, y: 6 },
  { delay: 2.8, duration: 8, y: -8 },
  { delay: 4.2, duration: 10, y: 18 },
  { delay: 5.6, duration: 9.5, y: -22 },
  { delay: 7.1, duration: 12, y: 12 },
];
