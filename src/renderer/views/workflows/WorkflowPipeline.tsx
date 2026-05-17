import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type {
  WorkflowDef,
  WorkflowNodeDef,
  WorkflowRun,
  WorkflowRunStep,
} from '../../../shared/types';

/**
 * Graph-first view of a workflow's pipeline. Built on @xyflow/react
 * because the future story is a click-to-edit n8n-style editor —
 * pan/zoom, custom node components, minimap, and connection drawing
 * all come for free. For V1 the graph is read-only and laid out
 * automatically (linear), but the same component will grow drag /
 * connect handlers without redoing the substrate.
 *
 * Live status comes from the most recent run: idle / running /
 * completed / errored / skipped per node. Running nodes pulse;
 * connectors between completed and running nodes glow live.
 */

type StageState = 'idle' | 'running' | 'completed' | 'errored' | 'skipped';

interface PipelineNodeData extends Record<string, unknown> {
  node: WorkflowNodeDef;
  index: number;
  state: StageState;
}

interface Props {
  workflow: WorkflowDef;
  run: WorkflowRun | null;
  onNodeClick?: (index: number) => void;
}

const NODE_X_SPACING = 340;
const NODE_X_OFFSET = 60;
const NODE_Y = 80;

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
    return run.status === 'running' ? 'idle' : 'skipped';
  }
  return step.status;
}

/**
 * Short, human label pulled out of a node's params. Helps tell two
 * `http-fetch` nodes apart at a glance ("api.linear.app" vs
 * "slack.com/api/search.messages"). Falls back to the type name.
 */
function summaryFor(node: WorkflowNodeDef): string {
  const p = node.params ?? {};
  if (node.type === 'http-fetch' && typeof p.url === 'string') {
    try {
      const u = new URL(p.url);
      const path = u.pathname.length > 1 ? u.pathname : '';
      return `${u.host}${path}`.slice(0, 36);
    } catch {
      return String(p.url).slice(0, 36);
    }
  }
  if (node.type === 'inbox-write' && typeof p.source === 'string') {
    return `→ ${p.source}`;
  }
  if (node.type === 'osascript' && typeof p.script === 'string') {
    return `${p.script.trim().slice(0, 32)}…`;
  }
  if (node.type === 'shell' && typeof p.cmd === 'string') {
    return String(p.cmd).slice(0, 36);
  }
  if (node.type === 'run-skill' && typeof p.skillId === 'string') {
    return String(p.skillId);
  }
  if (node.type === 'notify' && typeof p.title === 'string') {
    return String(p.title).slice(0, 36);
  }
  return '';
}

function PipelineNode({ data }: NodeProps<Node<PipelineNodeData>>) {
  const { node, index, state } = data;
  const icon = iconFor(node.type);
  const summary = summaryFor(node);
  return (
    <div
      className={`wf-node wf-node--${state}`}
      style={{
        ['--node-hue' as string]: icon.hue,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="wf-node__handle"
      />
      <div className="wf-node__row">
        <span className="wf-node__index">{index + 1}</span>
        <span className="wf-node__glyph">{icon.glyph}</span>
        <div className="wf-node__meta">
          <span className="wf-node__type">{node.type}</span>
          {summary && <span className="wf-node__summary">{summary}</span>}
        </div>
      </div>
      {state !== 'idle' && (
        <span className={`wf-node__status wf-node__status--${state}`}>
          {state}
        </span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="wf-node__handle"
      />
    </div>
  );
}

const NODE_TYPES = { pipeline: PipelineNode };

function edgeStyleFor(
  prev: StageState,
  next: StageState,
): { stroke: string; animated: boolean } {
  if (prev === 'errored') return { stroke: '#FF8585', animated: false };
  if (prev === 'completed' && next === 'running')
    return { stroke: '#4DA3FF', animated: true };
  if (prev === 'completed' && next === 'completed')
    return { stroke: '#7AE2A0', animated: false };
  return { stroke: 'rgba(255,255,255,0.25)', animated: false };
}

export function WorkflowPipeline({ workflow, run, onNodeClick }: Props) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node<PipelineNodeData>[] = workflow.pipeline.map(
      (node, i) => ({
        id: `n${i}`,
        type: 'pipeline',
        position: { x: NODE_X_OFFSET + i * NODE_X_SPACING, y: NODE_Y },
        data: { node, index: i, state: stateOf(run, i) },
        draggable: false,
        connectable: false,
        selectable: !!onNodeClick,
      }),
    );
    const edges: Edge[] = [];
    for (let i = 0; i < workflow.pipeline.length - 1; i++) {
      const prevState = stateOf(run, i);
      const nextState = stateOf(run, i + 1);
      const style = edgeStyleFor(prevState, nextState);
      edges.push({
        id: `e${i}`,
        source: `n${i}`,
        target: `n${i + 1}`,
        animated: style.animated,
        style: { stroke: style.stroke, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
      });
    }
    return { nodes, edges };
  }, [workflow, run, onNodeClick]);

  const showMinimap = workflow.pipeline.length > 4;

  return (
    <div className="wf-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={
          onNodeClick
            ? (_, n) => {
                const d = n.data as PipelineNodeData;
                onNodeClick(d.index);
              }
            : undefined
        }
        panOnDrag
        zoomOnScroll
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={!!onNodeClick}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="rgba(255,255,255,0.06)"
        />
        <Controls
          showInteractive={false}
          className="wf-canvas__controls"
        />
        {showMinimap && (
          <MiniMap
            className="wf-canvas__minimap"
            nodeColor={(n) =>
              iconFor((n.data as PipelineNodeData).node.type).hue
            }
            maskColor="rgba(8, 14, 20, 0.7)"
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </div>
  );
}
