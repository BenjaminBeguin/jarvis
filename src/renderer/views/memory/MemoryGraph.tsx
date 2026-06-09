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
  type GraphMode,
  type SemanticEdge,
} from './types';

interface Props {
  showSemantic: boolean;
  semanticThreshold: number;
  kindFilter: Set<string> | null;
  sinceMs: number | null;
  /** 'artifact' = one node per meeting/note/etc. 'facet' = one node
   *  per chunk for multi-chunk artifacts, so a meeting with 3 topics
   *  shows up in 3 clusters. */
  mode: GraphMode;
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

function Inner({
  showSemantic,
  semanticThreshold,
  kindFilter,
  sinceMs,
  mode,
}: Props) {
  const [allNodes, setAllNodes] = useState<ArtifactNode[]>([]);
  const [explicit, setExplicit] = useState<ExplicitEdge[]>([]);
  const [semantic, setSemantic] = useState<SemanticEdge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        if (mode === 'facet') {
          const [facets, links, neigh] = await Promise.all([
            window.jarvis.artifactsListFacets({ limit: 800 }),
            window.jarvis.artifactsLinks(),
            window.jarvis.artifactsSemanticChunkNeighbors({
              threshold: semanticThreshold,
              k: 5,
            }),
          ]);
          setAllNodes(
            facets.map((f) => ({
              id: f.id,
              kind: f.kind,
              title: f.title,
              project: f.project,
              updatedAt: f.updatedAt,
              artifactId: f.artifactId,
              heading: f.heading,
              ord: f.ord,
            })),
          );
          setExplicit(links);
          setSemantic(neigh);
        } else {
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
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [semanticThreshold, mode]);

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
    // Facet mode: emit thin grey "same source" edges between
    // consecutive chunks of the same artifact. Lets the user see at
    // a glance "these three nodes are all the same meeting" without
    // exploding edge count (N-1 per artifact instead of N*(N-1)/2).
    if (mode === 'facet') {
      const bySource = new Map<string, ArtifactNode[]>();
      for (const n of visibleNodes) {
        if (!n.artifactId || n.artifactId === n.id) continue;
        let arr = bySource.get(n.artifactId);
        if (!arr) {
          arr = [];
          bySource.set(n.artifactId, arr);
        }
        arr.push(n);
      }
      for (const [artId, siblings] of bySource) {
        siblings.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
        for (let i = 0; i < siblings.length - 1; i++) {
          out.push({
            id: `ss:${artId}:${siblings[i]!.id}->${siblings[i + 1]!.id}`,
            source: siblings[i]!.id,
            target: siblings[i + 1]!.id,
            style: {
              stroke: 'rgba(160, 175, 195, 0.18)',
              strokeWidth: 1,
              strokeDasharray: '1 4',
            },
          });
        }
      }
    }
    return out;
  }, [explicit, cappedSemantic, showSemantic, visibleIds, visibleNodes, mode]);

  // Count same-source chunk links separately from the explicit /
  // semantic categories so the legend can show them. They're emitted
  // above with an id prefix of `ss:` — counting filters that prefix.
  const sameSourceCount = useMemo(
    () => flowEdges.filter((e) => e.id.startsWith('ss:')).length,
    [flowEdges],
  );

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
        <span
          className="memory-graph__legend-count"
          title={
            mode === 'facet'
              ? 'Same-source: faint dotted lines connect chunks of the same artifact (a meeting / note split across multiple sections).\n\nExplicit: solid cyan lines from spawned / mentions / sourced-from links in the artifact_links table.\n\nSemantic: dashed→solid lines between chunks whose cosine similarity is above the threshold (lower the slider to see more).'
              : 'Explicit: solid cyan lines from spawned / mentions / sourced-from links.\n\nSemantic: dashed→solid lines between artifacts whose cosine similarity is above the threshold.'
          }
        >
          {visibleNodes.length} nodes · {explicit.length} explicit
          {showSemantic && ` · ${cappedSemantic.length} semantic`}
          {mode === 'facet' && ` · ${sameSourceCount} same-source`}
        </span>
      </div>
    </div>
  );
}

/** Per-node renderer. In facet mode the visible label is the chunk
 *  heading (since the artifact title is identical across siblings)
 *  and the tooltip carries the parent's title. */
function ArtifactGlyph({ data }: NodeProps<ArtifactNodeType>) {
  const { artifact, selected } = data;
  const style = styleForKind(artifact.kind);
  // Facet with a heading → show heading as the label, keep title in
  // the tooltip. Falls back to the title for single-chunk facets and
  // for nodes in artifact mode.
  const labelText = artifact.heading || artifact.title;
  const tooltip =
    artifact.heading && artifact.title
      ? `${artifact.title} · ${artifact.heading}`
      : artifact.title;
  const truncated =
    labelText.length > 28 ? `${labelText.slice(0, 27)}…` : labelText;
  const isFacet = !!artifact.heading;
  return (
    <div
      className={`mem-node mem-node--${artifact.kind}${selected ? ' mem-node--selected' : ''}${isFacet ? ' mem-node--facet' : ''}`}
      style={{ '--mem-tint': style.tint } as React.CSSProperties}
      title={tooltip}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="mem-node__glyph">{style.glyph}</div>
      <div className="mem-node__title">{truncated}</div>
      {isFacet && (
        <div className="mem-node__subtitle">
          {artifact.title.length > 30
            ? `${artifact.title.slice(0, 29)}…`
            : artifact.title}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
