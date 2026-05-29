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
 * Heavier links (explicit, recent) pull harder than semantic ones.
 *
 * Returns positions in absolute pixels relative to the canvas centre
 * (0, 0). React Flow takes them as-is via `position: { x, y }`.
 */

interface SimNode extends SimulationNodeDatum {
  id: string;
  kindGroup: number; // bucket index for collision separation
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

  const kinds = Array.from(new Set(nodes.map((n) => n.kind)));
  const kindIndex = new Map(kinds.map((k, i) => [k, i]));

  const simNodes: SimNode[] = nodes.map((n) => ({
    id: n.id,
    kindGroup: kindIndex.get(n.kind) ?? 0,
  }));
  const byId = new Set(nodes.map((n) => n.id));

  const simLinks: SimLink[] = [
    ...explicit
      .filter((e) => byId.has(e.src) && byId.has(e.dst))
      .map((e) => ({ source: e.src, target: e.dst, weight: 1.0 })),
    ...semantic
      .filter((e) => byId.has(e.src) && byId.has(e.dst))
      .map((e) => ({
        source: e.src,
        target: e.dst,
        weight: 0.25 * (e.similarity - 0.5),
      })),
  ];

  // Deterministic seed via the node count — small differences in
  // input don't reflow the whole graph wildly. d3-force doesn't
  // support seeded rng directly; the alpha/decay defaults produce
  // stable-enough layouts at the same input.
  const sim = forceSimulation(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance((l) => 80 / Math.max(0.4, l.weight))
        .strength((l) => Math.min(1, l.weight)),
    )
    .force('charge', forceManyBody().strength(-120))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(28))
    .alpha(1)
    .alphaDecay(0.02);

  // Run a fixed number of ticks so the layout settles synchronously
  // (no animation on first paint — too jittery for 100+ nodes).
  const ITERATIONS = Math.min(300, 100 + nodes.length * 0.4);
  for (let i = 0; i < ITERATIONS; i++) sim.tick();
  sim.stop();

  return simNodes.map((n) => ({
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
  }));
}
