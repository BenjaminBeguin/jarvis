import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

import type { ArtifactNode, ExplicitEdge, SemanticEdge } from './types';

/**
 * Run a deterministic d3-force simulation to give each node an (x, y).
 *
 * Layout philosophy: **topics, not types.** A meeting about pricing,
 * a Linear ticket about pricing, and a note about pricing should land
 * next to each other regardless of their kind. So we drive the
 * simulation entirely from explicit + semantic links — same-kind
 * attraction would just fight the topic signal.
 *
 * Two layers of pull:
 *   1. Explicit links (artifact_links) — strongest. These are facts:
 *      this reminder came from this meeting.
 *   2. Semantic similarity above threshold — the "meaning" signal.
 *      Capped per-node so a hub artifact doesn't drag a hairball.
 */

interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: string;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string;
  target: string;
  weight: number;
}

export interface NodePosition {
  id: string;
  x: number;
  y: number;
}

/** Trim per-node edge count to `perNode` strongest. Stops hub
 *  artifacts (a busy briefing that touches every project) from
 *  dragging hundreds of weak neighbours into the simulation. */
function capEdgesPerNode(
  edges: SemanticEdge[],
  perNode: number,
): SemanticEdge[] {
  const sorted = [...edges].sort((a, b) => b.similarity - a.similarity);
  const counts = new Map<string, number>();
  const kept: SemanticEdge[] = [];
  for (const e of sorted) {
    const cs = counts.get(e.src) ?? 0;
    const cd = counts.get(e.dst) ?? 0;
    if (cs >= perNode || cd >= perNode) continue;
    counts.set(e.src, cs + 1);
    counts.set(e.dst, cd + 1);
    kept.push(e);
  }
  return kept;
}

export function computeLayout(
  nodes: ArtifactNode[],
  explicit: ExplicitEdge[],
  semantic: SemanticEdge[],
): { positions: NodePosition[]; usedEdges: SemanticEdge[] } {
  if (nodes.length === 0) return { positions: [], usedEdges: [] };

  const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id, kind: n.kind }));
  const byId = new Set(nodes.map((n) => n.id));
  const cappedSemantic = capEdgesPerNode(
    semantic.filter((e) => byId.has(e.src) && byId.has(e.dst)),
    6,
  );

  const simLinks: SimLink[] = [
    ...explicit
      .filter((e) => byId.has(e.src) && byId.has(e.dst))
      .map((e) => ({ source: e.src, target: e.dst, weight: 1.0 })),
    // Semantic edges: weight scales nonlinearly with similarity so
    // very-close pairs cluster much tighter than barely-above-
    // threshold pairs. (similarity - 0.5) ^ 1.4 boosts the high end.
    ...cappedSemantic.map((e) => ({
      source: e.src,
      target: e.dst,
      weight: Math.pow(Math.max(0, e.similarity - 0.4), 1.4) * 3,
    })),
  ];

  const sim = forceSimulation(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        // Closer for stronger links. The 1/weight formula gives
        // tight clusters when many edges agree.
        .distance((l) => 40 / Math.max(0.2, l.weight))
        .strength((l) => Math.min(1, l.weight * 0.7)),
    )
    // Charge: enough repulsion that dense clusters don't collapse
    // into one black hole, light enough to let the link forces win.
    .force('charge', forceManyBody().strength(-45))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(30))
    .alpha(1)
    .alphaDecay(0.018);

  const ITERATIONS = Math.min(500, 150 + nodes.length * 0.5);
  for (let i = 0; i < ITERATIONS; i++) sim.tick();
  sim.stop();

  return {
    positions: simNodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 })),
    usedEdges: cappedSemantic,
  };
}
