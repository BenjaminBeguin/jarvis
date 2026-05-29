/**
 * Shapes the renderer-side memory graph passes around. These mirror
 * the IPC return types from preload but are repeated here so the
 * graph component doesn't import from electron/.
 */

export interface ArtifactNode {
  id: string;
  kind: string;
  title: string;
  project: string | null;
  updatedAt: number;
  /** Set when this node is a chunk-level facet of a longer
   *  artifact. Drives the detail-panel "open full artifact"
   *  affordance and the same-source edge layer. */
  artifactId?: string;
  /** Section heading (e.g. "Action items") when the node is a
   *  facet. Used as the visible label since the title is shared
   *  across siblings. */
  heading?: string | null;
  ord?: number;
}

export type GraphMode = 'artifact' | 'facet';

export interface ExplicitEdge {
  src: string;
  dst: string;
  kind: string;
}

export interface SemanticEdge {
  src: string;
  dst: string;
  similarity: number;
}

export interface ArtifactDetail extends ArtifactNode {
  path: string | null;
  url: string | null;
  createdAt: number;
  frontmatter: Record<string, unknown> | null;
  content: string;
  linksOut: Array<{ to: string; kind: string }>;
  linksIn: Array<{ from: string; kind: string }>;
}

/** Map of kind → display config: glyph + colour + label. */
export const KIND_STYLES: Record<
  string,
  { label: string; glyph: string; tint: string }
> = {
  meeting: { label: 'Meeting', glyph: '◉', tint: 'rgb(77, 200, 230)' },
  note: { label: 'Note', glyph: '✎', tint: 'rgb(255, 207, 138)' },
  briefing: { label: 'Briefing', glyph: '◆', tint: 'rgb(180, 138, 255)' },
  'project-memory': {
    label: 'Project memory',
    glyph: '⌬',
    tint: 'rgb(122, 220, 180)',
  },
  goal: { label: 'Goal', glyph: '◎', tint: 'rgb(255, 138, 178)' },
  reminder: { label: 'Reminder', glyph: '⏱', tint: 'rgb(160, 200, 235)' },
  task: { label: 'Task', glyph: '▷', tint: 'rgb(220, 220, 220)' },
  draft: { label: 'Draft', glyph: '✦', tint: 'rgb(245, 195, 110)' },
  'action-item': {
    label: 'Action item',
    glyph: '→',
    tint: 'rgb(255, 168, 168)',
  },
};

export function styleForKind(
  kind: string,
): { label: string; glyph: string; tint: string } {
  return (
    KIND_STYLES[kind] ?? {
      label: kind,
      glyph: '◌',
      tint: 'rgb(160, 160, 180)',
    }
  );
}
