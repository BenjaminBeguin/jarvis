import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

import type { ArtifactNode, ExplicitEdge, SemanticEdge } from './types';

/**
 * Run a deterministic d3-force simulation to give each node an (x, y).
 *
 * Three sources of attraction layered together:
 *
 *   1. Explicit links (strongest) — meeting → reminder etc.
 *   2. Semantic neighbours — pairs with cosine ≥ threshold. Used as
 *      layout force REGARDLESS of whether the user has the dotted
 *      edges visually rendered, so topic clusters always emerge.
 *   3. Same-kind attraction — every kind has a soft anchor point on
 *      a circle around the origin, and same-kind nodes get pulled
 *      toward that anchor. Produces clean visual grouping by type.
 *
 * Without these layered forces the graph collapses to a grid (charge
 * repulsion + center + collide only — no clustering signal).
 */

interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: string;
  anchorX: number;
  anchorY: number;
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

export function computeLayout(
  nodes: ArtifactNode[],
  explicit: ExplicitEdge[],
  semantic: SemanticEdge[],
): NodePosition[] {
  if (nodes.length === 0) return [];

  // Anchor each kind to a point on a ring around the origin so same-
  // kind nodes have somewhere consistent to drift toward. The ring
  // radius scales with node count so dense graphs don't collapse on
  // top of each other.
  const kinds = Array.from(new Set(nodes.map((n) => n.kind)));
  const ringRadius = Math.max(180, Math.sqrt(nodes.length) * 35);
  const kindAnchor = new Map<string, { x: number; y: number }>();
  kinds.forEach((k, i) => {
    const angle = (i / kinds.length) * Math.PI * 2 - Math.PI / 2;
    kindAnchor.set(k, {
      x: Math.cos(angle) * ringRadius,
      y: Math.sin(angle) * ringRadius,
    });
  });

  const simNodes: SimNode[] = nodes.map((n) => {
    const anchor = kindAnchor.get(n.kind) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      kind: n.kind,
      anchorX: anchor.x,
      anchorY: anchor.y,
    };
  });
  const byId = new Set(nodes.map((n) => n.id));

  const simLinks: SimLink[] = [
    ...explicit
      .filter((e) => byId.has(e.src) && byId.has(e.dst))
      .map((e) => ({ source: e.src, target: e.dst, weight: 1.0 })),
    // Semantic edges as layout force: weight scales with similarity
    // above the threshold (already pre-filtered upstream). Even a
    // moderate weight produces visible clusters at 800+ nodes.
    ...semantic
      .filter((e) => byId.has(e.src) && byId.has(e.dst))
      .map((e) => ({
        source: e.src,
        target: e.dst,
        weight: Math.max(0.15, (e.similarity - 0.6) * 1.5),
      })),
  ];

  const sim = forceSimulation(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        // Heavier links pull nodes closer.
        .distance((l) => 60 / Math.max(0.3, l.weight))
        .strength((l) => Math.min(1, l.weight)),
    )
    // Charge: tuned so dense clusters don't collapse but sparse
    // areas have breathing room.
    .force('charge', forceManyBody().strength(-60))
    // Same-kind attraction — pull each node toward its kind's anchor
    // point. Weak (0.05) so it doesn't dominate the link forces but
    // strong enough that disconnected nodes drift toward their kin.
    .force(
      'kindX',
      forceX<SimNode>((d) => d.anchorX).strength(0.06),
    )
    .force(
      'kindY',
      forceY<SimNode>((d) => d.anchorY).strength(0.06),
    )
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(32))
    .alpha(1)
    .alphaDecay(0.02);

  const ITERATIONS = Math.min(400, 120 + nodes.length * 0.4);
  for (let i = 0; i < ITERATIONS; i++) sim.tick();
  sim.stop();

  return simNodes.map((n) => ({
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
  }));
}
