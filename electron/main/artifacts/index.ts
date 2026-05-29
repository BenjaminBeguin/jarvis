import { homedir } from 'node:os';
import { join, relative } from 'node:path';

export {
  archiveArtifact,
  countByKind,
  deleteArtifact,
  listAllLinks,
  listArtifacts,
  listFacets,
  readArtifact,
  readChunk,
  semanticChunkNeighbors,
  semanticNeighbors,
  upsertArtifact,
  walkArtifactGraph,
} from './registry.js';
export { searchArtifacts } from './search.js';
export { backfillArtifacts, backfillEvents } from './backfill.js';
export { startArtifactWatchers, stopArtifactWatchers } from './watchers.js';

/**
 * Given a `vscode://file<absolute-path>` URL pointing at a Jarvis-
 * managed markdown file (meeting / note / briefing), return the
 * matching artifact id (`<kind>:<slug>`). Used to back-link
 * reminders + action items to their source meeting in the artifact
 * graph.
 *
 * Returns null when the URL doesn't point at a recognised directory.
 */
export function artifactIdFromVscodeUrl(url: string): string | null {
  if (!url.startsWith('vscode://file')) return null;
  const path = url.replace(/^vscode:\/\/file/, '');
  const jarvisRoot = join(homedir(), '.jarvis');
  for (const [kind, sub] of [
    ['meeting', 'meetings'],
    ['note', 'notes'],
    ['briefing', 'briefings'],
  ] as const) {
    const root = join(jarvisRoot, sub);
    if (path.startsWith(root)) {
      const rel = relative(root, path).replace(/[\\/]/g, '__').replace(/\.md$/i, '');
      return `${kind}:${rel}`;
    }
  }
  return null;
}
