import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useEffect, useMemo, useState } from 'react';

import { computeLayout } from './layout';
import { MemoryDetailPanel } from './MemoryDetailPanel';
import {
  styleForKind,
  type ArtifactNode,
  type ExplicitEdge,
  type SemanticEdge,
} from './types';

interface Props {
  showSemantic: boolean;
  semanticThreshold: number;
  kindFilter: Set<string> | null;
  sinceMs: number | null;
}

interface NodeData extends Record<string, unknown> {
  artifact: ArtifactNode;
  selected: boolean;
}

type ArtifactNodeType = Node<NodeData, 'artifact'>;

/**
 * Force-directed graph of every Jarvis-owned artifact + their
 * relationships. Two edge layers:
 *
 *   - Explicit links (artifact_links table) — solid, accent-colour.
 *   - Semantic neighbours (cosine similarity above threshold) —
 *     dotted, dimmer. Optional via the chrome's toggle.
 *
 * Click any node → opens a side panel with the artifact's full
 * content, frontmatter, and incoming/outgoing links (drilldown to
 * neighbours).
 *
 * Layout runs d3-force once on mount; positions are then static
 * unless the filter set changes. React Flow handles pan / zoom /
 * drag-to-reposition (no auto-reflow on drag — the user can
 * arrange manually).
 */
export function MemoryGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

function Inner({ showSemantic, semanticThreshold, kindFilter, sinceMs }: Props) {
  const [allNodes, setAllNodes] = useState<ArtifactNode[]>([]);
  const [explicit, setExplicit] = useState<ExplicitEdge[]>([]);
  const [semantic, setSemantic] = useState<SemanticEdge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [list, links, neigh] = await Promise.all([
          window.jarvis.artifactsList({ limit: 1000 }),
          window.jarvis.artifactsLinks(),
          window.jarvis.artifactsSemanticNeighbors({
            threshold: semanticThreshold,
            k: 4,
          }),
        ]);
        setAllNodes(list);
        setExplicit(links);
        setSemantic(neigh);
      } finally {
        setLoading(false);
      }
    })();
  }, [semanticThreshold]);

  const visibleNodes = useMemo(() => {
    return allNodes.filter((n) => {
      if (kindFilter && !kindFilter.has(n.kind)) return false;
      if (sinceMs && n.updatedAt < sinceMs) return false;
      return true;
    });
  }, [allNodes, kindFilter, sinceMs]);

  const layout = useMemo(() => {
    if (visibleNodes.length === 0) {
      return {
        positions: new Map<string, { x: number; y: number }>(),
        usedEdges: [] as SemanticEdge[],
      };
    }
    // Semantic edges drive both layout AND visual edges. We cap per-
    // node inside the layout so a hub artifact doesn't produce a
    // hairball; the SAME capped set is what we render below.
    const { positions, usedEdges } = computeLayout(visibleNodes, explicit, semantic);
    return {
      positions: new Map(positions.map((p) => [p.id, { x: p.x, y: p.y }])),
      usedEdges,
    };
  }, [visibleNodes, explicit, semantic]);
  const positions = layout.positions;
  const cappedSemantic = layout.usedEdges;

  const flowNodes: ArtifactNodeType[] = useMemo(
    () =>
      visibleNodes.map((n) => ({
        id: n.id,
        type: 'artifact' as const,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { artifact: n, selected: n.id === selectedId },
        draggable: true,
      })),
    [visibleNodes, positions, selectedId],
  );

  const visibleIds = useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes],
  );
  const flowEdges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const e of explicit) {
      if (!visibleIds.has(e.src) || !visibleIds.has(e.dst)) continue;
      out.push({
        id: `e:${e.src}->${e.dst}:${e.kind}`,
        source: e.src,
        target: e.dst,
        animated: false,
        style: {
          stroke: 'rgba(77, 200, 230, 0.55)',
          strokeWidth: 1.2,
        },
        label: e.kind,
        labelStyle: {
          fill: 'rgba(160, 195, 220, 0.7)',
          fontSize: 9,
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
        },
        labelBgStyle: { fill: 'rgba(22, 28, 38, 0.85)' },
      });
    }
    if (showSemantic) {
      for (const s of cappedSemantic) {
        if (!visibleIds.has(s.src) || !visibleIds.has(s.dst)) continue;
        // Color + opacity scale with similarity so the strongest
        // topic ties are most prominent. At sim ≥ 0.75 they're
        // bright cyan-tinted; lower ties fade toward purple/dim.
        const t = Math.min(1, Math.max(0, (s.similarity - 0.4) / 0.4));
        const alpha = 0.18 + t * 0.45;
        // Hue blends purple (180, 138, 255) → bright cyan-ish
        // (138, 220, 255) as similarity climbs.
        const r = Math.round(180 - 42 * t);
        const g = Math.round(138 + 82 * t);
        const b = Math.round(255);
        out.push({
          id: `s:${s.src}~${s.dst}`,
          source: s.src,
          target: s.dst,
          style: {
            stroke: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
            strokeWidth: 0.6 + t * 0.9,
            strokeDasharray: t > 0.7 ? undefined : '3 3',
          },
        });
      }
    }
    return out;
  }, [explicit, cappedSemantic, showSemantic, visibleIds]);

  return (
    <div className="memory-graph">
      {loading && (
        <div className="memory-graph__overlay">
          <span className="memory-graph__loading">INITIALISING SUBSTRATE…</span>
        </div>
      )}
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={{ artifact: ArtifactGlyph }}
        onNodeClick={(_e, n) => setSelectedId(n.id)}
        onPaneClick={() => setSelectedId(null)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.1}
        maxZoom={3}
      >
        <Background gap={32} size={1} color="rgba(150, 195, 220, 0.08)" />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="memory-graph__controls"
        />
      </ReactFlow>
      {selectedId && (
        <MemoryDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onOpen={(id) => setSelectedId(id)}
        />
      )}
      <div className="memory-graph__legend">
        <span className="memory-graph__legend-count">
          {visibleNodes.length} nodes · {explicit.length} explicit
          {showSemantic && ` · ${cappedSemantic.length} semantic`}
        </span>
      </div>
    </div>
  );
}

/** Per-node renderer — small glyph + title under it. */
function ArtifactGlyph({ data }: NodeProps<ArtifactNodeType>) {
  const { artifact, selected } = data;
  const style = styleForKind(artifact.kind);
  const truncated =
    artifact.title.length > 28
      ? `${artifact.title.slice(0, 27)}…`
      : artifact.title;
  return (
    <div
      className={`mem-node mem-node--${artifact.kind}${selected ? ' mem-node--selected' : ''}`}
      style={{ '--mem-tint': style.tint } as React.CSSProperties}
      title={artifact.title}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="mem-node__glyph">{style.glyph}</div>
      <div className="mem-node__title">{truncated}</div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
