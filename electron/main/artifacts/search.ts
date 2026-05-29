import type {
  ArtifactKind,
  ArtifactSearchHit,
  ArtifactSearchMode,
  ArtifactSearchQuery,
} from '@shared/types';

import { getDb, isVecAvailable } from '../db.js';
import { embed } from '../embeddings/embed-worker-host.js';

/**
 * Hybrid search across the artifact substrate. Two underlying paths:
 *
 *   - FTS5 (lexical): millisecond exact-token + prefix matches via
 *     the artifact_fts virtual table. Best for unique terms / phrases.
 *   - sqlite-vec (semantic): KNN by cosine on the chunk embeddings.
 *     Best for paraphrases / concept matches.
 *
 * Hybrid mode runs both in parallel and combines with reciprocal-rank
 * fusion (RRF), then reranks by (recency + project match) so a recent
 * artifact in the active project floats above an old one with a
 * slightly better score. Falls back gracefully to lexical-only when
 * sqlite-vec isn't loaded.
 *
 * Returns top-N hits with FTS snippets where available.
 */

interface FtsRow {
  artifact_id: string;
  chunk_id: string;
  kind: string;
  title: string;
  snippet: string;
  rank: number;
}

interface VecRow {
  chunk_id: string;
  artifact_id: string;
  distance: number;
}

interface ArtifactMetaRow {
  id: string;
  kind: string;
  title: string;
  project: string | null;
  updated_at: number;
}

export async function searchArtifacts(
  q: ArtifactSearchQuery,
  activeProject?: string | null,
): Promise<ArtifactSearchHit[]> {
  const mode: ArtifactSearchMode = q.mode ?? 'hybrid';
  const limit = Math.max(1, Math.min(q.limit ?? 10, 50));

  const wantsLexical = mode !== 'semantic';
  const wantsSemantic = (mode === 'semantic' || mode === 'hybrid') && isVecAvailable();

  // Fetch more than `limit` from each path so the fusion + rerank has
  // room to discover good hits the other path missed.
  const fetchK = limit * 3;
  const [ftsHits, vecHits] = await Promise.all([
    wantsLexical ? runFts(q, fetchK) : [],
    wantsSemantic ? runVec(q, fetchK) : [],
  ]);

  // Reciprocal-rank fusion. Each hit gets sum_{paths} (1 / (k + rank)),
  // where k=60 is the standard constant (Cormack et al. 2009).
  const RRF_K = 60;
  type Fused = {
    artifact_id: string;
    chunk_id: string;
    snippet: string;
    score: number;
    via: 'lexical' | 'semantic' | 'both';
  };
  const fused = new Map<string, Fused>();
  ftsHits.forEach((row, rank) => {
    const entry = fused.get(row.artifact_id);
    const inc = 1 / (RRF_K + rank);
    if (entry) {
      entry.score += inc;
      entry.via = 'both';
      if (!entry.snippet) entry.snippet = row.snippet;
    } else {
      fused.set(row.artifact_id, {
        artifact_id: row.artifact_id,
        chunk_id: row.chunk_id,
        snippet: row.snippet,
        score: inc,
        via: 'lexical',
      });
    }
  });
  vecHits.forEach((row, rank) => {
    const entry = fused.get(row.artifact_id);
    const inc = 1 / (RRF_K + rank);
    if (entry) {
      entry.score += inc;
      entry.via = entry.via === 'lexical' ? 'both' : entry.via;
    } else {
      fused.set(row.artifact_id, {
        artifact_id: row.artifact_id,
        chunk_id: row.chunk_id,
        snippet: '',
        score: inc,
        via: 'semantic',
      });
    }
  });

  if (fused.size === 0) return [];

  // Bring in artifact metadata for rerank.
  const ids = Array.from(fused.keys());
  const placeholders = ids.map(() => '?').join(', ');
  const meta = getDb()
    .prepare(
      `SELECT id, kind, title, project, updated_at FROM artifacts
       WHERE id IN (${placeholders}) AND archived = 0`,
    )
    .all(...ids) as ArtifactMetaRow[];
  const metaById = new Map(meta.map((r) => [r.id, r]));

  const now = Date.now();
  const reranked = Array.from(fused.values())
    .filter((f) => metaById.has(f.artifact_id))
    .map((f) => {
      const m = metaById.get(f.artifact_id)!;
      // Recency boost: a multiplicative bump that decays with age.
      // 1d old → +0.50; 7d → +0.25; 30d → +0.10; older → ~+0.
      const ageDays = (now - m.updated_at) / (24 * 60 * 60_000);
      const recency = 0.5 / (1 + ageDays / 3);
      // Project match: +0.25 if the artifact's project matches the
      // user's active project at query time.
      const projectMatch =
        activeProject && m.project === activeProject ? 0.25 : 0;
      return {
        ...f,
        meta: m,
        finalScore: f.score + recency + projectMatch,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit);

  return reranked.map((r) => ({
    id: r.meta.id,
    kind: r.meta.kind as ArtifactKind,
    title: r.meta.title,
    project: r.meta.project,
    updatedAt: r.meta.updated_at,
    snippet: r.snippet,
    score: r.finalScore,
    via: r.via,
  }));
}

function runFts(q: ArtifactSearchQuery, limit: number): FtsRow[] {
  const tokens = normaliseFts(q.query);
  if (!tokens) return [];
  const where: string[] = [`artifact_fts MATCH @match`];
  const params: Record<string, unknown> = { match: tokens, limit };
  if (q.kinds && q.kinds.length > 0) {
    where.push(
      `kind IN (${q.kinds.map((_, i) => `@kind${i}`).join(', ')})`,
    );
    q.kinds.forEach((k, i) => {
      params[`kind${i}`] = k;
    });
  }
  // Lexical SQL doesn't get project / since filters baked in — we'd
  // need to join `artifacts`, which fts5 doesn't love. Filter
  // post-hoc when the fused result hits the rerank.
  const sql = `
    SELECT
      artifact_id,
      chunk_id,
      kind,
      title,
      snippet(artifact_fts, 4, '«', '»', '…', 18) AS snippet,
      rank
    FROM artifact_fts
    WHERE ${where.join(' AND ')}
    ORDER BY rank
    LIMIT @limit
  `;
  try {
    return getDb().prepare(sql).all(params) as FtsRow[];
  } catch (err) {
    console.warn('[artifacts:fts] query failed', err);
    return [];
  }
}

/** FTS5 MATCH wants tokens, not raw user input — special chars (",
 *  *, etc.) and reserved words (AND, OR, NEAR) can blow up. Wrap
 *  each token in quotes for a safe phrase query. */
function normaliseFts(input: string): string {
  const cleaned = (input ?? '').trim();
  if (!cleaned) return '';
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

async function runVec(
  q: ArtifactSearchQuery,
  limit: number,
): Promise<VecRow[]> {
  if (!isVecAvailable()) return [];
  let vectors: Float32Array[];
  try {
    vectors = await embed([q.query]);
  } catch (err) {
    console.warn('[artifacts:vec] embed failed', err);
    return [];
  }
  const queryVec = vectors[0];
  if (!queryVec || queryVec.length === 0) return [];
  const queryBuf = Buffer.from(
    queryVec.buffer,
    queryVec.byteOffset,
    queryVec.byteLength,
  );
  // sqlite-vec uses vec_distance_cosine (lower = closer) or the
  // shortcut `embedding MATCH ?` for KNN ordering. Joining chunks
  // gives us artifact_id without a separate lookup.
  const sql = `
    SELECT
      e.chunk_id AS chunk_id,
      c.artifact_id AS artifact_id,
      e.distance AS distance
    FROM artifact_embeddings e
    JOIN artifact_chunks c ON c.id = e.chunk_id
    WHERE e.embedding MATCH ? AND k = ?
    ORDER BY e.distance
  `;
  try {
    return getDb().prepare(sql).all(queryBuf, limit) as VecRow[];
  } catch (err) {
    console.warn('[artifacts:vec] query failed', err);
    return [];
  }
}
