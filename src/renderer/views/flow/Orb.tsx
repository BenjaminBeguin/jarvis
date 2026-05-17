import { useState } from 'react';

import type { FlowEvent, FlowSource } from './types';
import { JITTER_RANGE, xForStage, yForStage } from './Pipeline';

/**
 * Color for an orb based on its source. Tuned for the dark UI — each
 * one is distinct enough to read at a glance but not so saturated that
 * a busy timeline becomes a Christmas tree.
 */
const SOURCE_COLOR: Record<FlowSource, string> = {
  palette: 'var(--accent)',
  voice: '#7ad8ff',
  cron: '#ffb454',
  reminder: '#ff9ec7',
  telegram: '#5fffa6',
  module: '#9cb9e0',
  notifier: 'rgba(220, 220, 220, 0.55)',
  unknown: 'rgba(160, 160, 160, 0.5)',
};

interface Props {
  event: FlowEvent;
  onClick: (event: FlowEvent) => void;
}

export function Orb({ event, onClick }: Props) {
  const [hover, setHover] = useState(false);
  const x = xForStage(event.stage);
  const baseY = yForStage(event.stage);
  const y = baseY - JITTER_RANGE + event.jitter * JITTER_RANGE * 2;
  const color = SOURCE_COLOR[event.source];
  const radius = event.kind === 'notification' ? 4 : 7;
  const isErrored = event.status === 'errored';
  const isAborted = event.status === 'aborted';
  const opacity = isAborted ? 0.4 : event.status === 'completed' ? 0.9 : 1;

  return (
    <g
      className="flow-orb"
      data-status={event.status}
      transform={`translate(${x}, ${y})`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onClick(event)}
      style={{ cursor: 'pointer' }}
    >
      {/* Trail — a faint streak pointing back toward the origin
          stage. Purely cosmetic; gives a sense of motion. */}
      <line
        x1={-32}
        y1={0}
        x2={-4}
        y2={0}
        stroke={color}
        strokeOpacity={0.25}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <circle
        r={radius}
        fill={isErrored ? '#ff5577' : color}
        opacity={opacity}
        filter="url(#flow-orb-glow)"
      />
      {hover && (
        <g className="flow-orb__tooltip" pointerEvents="none">
          <rect
            x={12}
            y={-30}
            rx={2}
            width={260}
            height={56}
            fill="rgba(4, 7, 11, 0.94)"
            stroke="rgba(0, 212, 255, 0.35)"
            strokeWidth={1}
          />
          <text x={24} y={-12} className="flow-orb__tooltip-title">
            {clip(event.label, 38)}
          </text>
          <text x={24} y={4} className="flow-orb__tooltip-meta">
            {event.source} · {event.kind} · {event.stage}
          </text>
          <text x={24} y={18} className="flow-orb__tooltip-meta">
            {event.status} · {ageLabel(event.enteredAt)}
          </text>
        </g>
      )}
    </g>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function ageLabel(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}
