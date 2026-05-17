import type { WorkflowDef, WorkflowRun, WorkflowRunStep } from '../../../shared/types';

/**
 * Visual rendering of a workflow's pipeline — one node per stage,
 * connector lines between them, status driven by the most recent run.
 *
 * No animation library; CSS keyframes power the running pulse and
 * connector flow. SVG so it stays crisp at any width.
 *
 * Layout: coordinate space scales with the node count so 2-node
 * workflows don't look stretched and 6-node ones don't get cramped.
 */

interface Props {
  workflow: WorkflowDef;
  run: WorkflowRun | null;
  trigger: WorkflowDef['trigger'];
  /** Click handler — receives the node index. Used to scroll the JSON
   *  editor to that node (optional). */
  onNodeClick?: (index: number) => void;
}

type StageState = 'idle' | 'running' | 'completed' | 'errored' | 'skipped';

const STAGE_W = 160;
const STAGE_GAP = 32;
const NODE_R = 28;
const ROW_Y = 70;
const HEIGHT = 150;

interface NodeIconSpec {
  glyph: string;
  hue: string;
}

const NODE_ICONS: Record<string, NodeIconSpec> = {
  'http-fetch': { glyph: '↗', hue: '#4DA3FF' },
  osascript: { glyph: 'Ⓐ', hue: '#FF9F7A' },
  shell: { glyph: '⌘', hue: '#C8A6FF' },
  transform: { glyph: 'ƒ', hue: '#FFD479' },
  'inbox-write': { glyph: '▣', hue: '#7AE2A0' },
  notify: { glyph: '◉', hue: '#FF8DD0' },
  'run-skill': { glyph: '✦', hue: '#7ADCFF' },
};

const DEFAULT_ICON: NodeIconSpec = { glyph: '◇', hue: '#9AA6B4' };

function iconFor(type: string): NodeIconSpec {
  return NODE_ICONS[type] ?? DEFAULT_ICON;
}

function stateOf(run: WorkflowRun | null, index: number): StageState {
  if (!run) return 'idle';
  const step: WorkflowRunStep | undefined = run.steps[index];
  if (!step) {
    // The run started but hasn't reached this node yet.
    return run.status === 'running' ? 'idle' : 'skipped';
  }
  return step.status;
}

function connectorState(
  prev: StageState,
  next: StageState,
): 'idle' | 'live' | 'done' | 'broken' {
  if (prev === 'errored') return 'broken';
  if (prev === 'completed' && next === 'running') return 'live';
  if (prev === 'completed' && (next === 'completed' || next === 'skipped'))
    return 'done';
  return 'idle';
}

function triggerLabel(t: WorkflowDef['trigger']): string {
  if (t.kind === 'cron') return `every ${t.every}`;
  if (t.kind === 'manual') return `manual${t.palette ? ' · /' + t.palette : ''}`;
  return `event · ${t.topic}`;
}

export function WorkflowPipeline({ workflow, run, trigger, onNodeClick }: Props) {
  const count = Math.max(1, workflow.pipeline.length);
  const totalW = count * STAGE_W + (count - 1) * STAGE_GAP + 80;

  return (
    <div className="wf-pipeline">
      <header className="wf-pipeline__head">
        <span className="wf-pipeline__trigger">
          <span className="wf-pipeline__trigger-dot" aria-hidden />
          {triggerLabel(trigger)}
        </span>
        {run && (
          <span className={`wf-pipeline__run-badge wf-pipeline__run-badge--${run.status}`}>
            last run · {run.status}
          </span>
        )}
      </header>
      <div className="wf-pipeline__scroll">
        <svg
          className="wf-pipeline__svg"
          viewBox={`0 0 ${totalW} ${HEIGHT}`}
          preserveAspectRatio="xMinYMid meet"
          width={totalW}
          height={HEIGHT}
        >
          <defs>
            <filter
              id="wf-node-glow"
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
          </defs>

          {workflow.pipeline.map((node, i) => {
            const x = 40 + i * (STAGE_W + STAGE_GAP) + STAGE_W / 2;
            const state = stateOf(run, i);
            const icon = iconFor(node.type);
            const nextNode = workflow.pipeline[i + 1];
            const nextX = nextNode
              ? 40 + (i + 1) * (STAGE_W + STAGE_GAP) + STAGE_W / 2
              : null;
            const nextState = nextNode ? stateOf(run, i + 1) : null;
            const conn = nextState
              ? connectorState(state, nextState)
              : 'idle';
            return (
              <g key={i} className={`wf-stage wf-stage--${state}`}>
                {/* Connector to the next node. Drawn from THIS stage so
                    its state controls the line color. */}
                {nextX !== null && (
                  <g className={`wf-conn wf-conn--${conn}`}>
                    <line
                      x1={x + NODE_R + 4}
                      y1={ROW_Y}
                      x2={nextX - NODE_R - 4}
                      y2={ROW_Y}
                      strokeDasharray="4 6"
                      className="wf-conn__line"
                    />
                    {conn === 'live' && (
                      <circle
                        r={3}
                        fill="currentColor"
                        className="wf-conn__bead"
                      >
                        <animateMotion
                          dur="1.4s"
                          repeatCount="indefinite"
                          path={`M${x + NODE_R + 4},${ROW_Y} L${nextX - NODE_R - 4},${ROW_Y}`}
                        />
                      </circle>
                    )}
                  </g>
                )}

                {/* Outer halo ring. */}
                <circle
                  cx={x}
                  cy={ROW_Y}
                  r={NODE_R + 4}
                  fill="none"
                  stroke={icon.hue}
                  strokeOpacity={0.25}
                  strokeWidth={1}
                  filter="url(#wf-node-glow)"
                  className="wf-stage__halo"
                />
                {/* Main node disk. */}
                <circle
                  cx={x}
                  cy={ROW_Y}
                  r={NODE_R}
                  fill={state === 'idle' ? 'rgba(255,255,255,0.04)' : `${icon.hue}22`}
                  stroke={icon.hue}
                  strokeOpacity={state === 'idle' ? 0.4 : 0.85}
                  strokeWidth={1.5}
                  className="wf-stage__disk"
                  onClick={onNodeClick ? () => onNodeClick(i) : undefined}
                  style={{ cursor: onNodeClick ? 'pointer' : undefined }}
                />
                {/* Glyph icon. */}
                <text
                  x={x}
                  y={ROW_Y + 8}
                  textAnchor="middle"
                  className="wf-stage__glyph"
                  fill={icon.hue}
                  pointerEvents="none"
                >
                  {icon.glyph}
                </text>
                {/* Node type label below. */}
                <text
                  x={x}
                  y={ROW_Y + NODE_R + 22}
                  textAnchor="middle"
                  className="wf-stage__label"
                  pointerEvents="none"
                >
                  {node.type}
                </text>
                {/* Index badge above. */}
                <text
                  x={x}
                  y={ROW_Y - NODE_R - 10}
                  textAnchor="middle"
                  className="wf-stage__index"
                  pointerEvents="none"
                >
                  {i + 1}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <footer className="wf-pipeline__legend">
        <Swatch state="idle" label="idle" />
        <Swatch state="running" label="running" />
        <Swatch state="completed" label="done" />
        <Swatch state="errored" label="error" />
        <Swatch state="skipped" label="skipped" />
      </footer>
    </div>
  );
}

function Swatch({ state, label }: { state: StageState; label: string }) {
  return (
    <span className={`wf-swatch wf-swatch--${state}`}>
      <span className="wf-swatch__dot" aria-hidden />
      {label}
    </span>
  );
}
