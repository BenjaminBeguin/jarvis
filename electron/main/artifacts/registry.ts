import type {
  ArtifactFull,
  ArtifactGraphEdge,
  ArtifactGraphSnapshot,
  ArtifactInput,
  ArtifactKind,
  ArtifactSummary,
} from '@shared/types';

import { getDb, isVecAvailable } from '../db.js';
import { embed } from '../embeddings/embed-worker-host.js';
import { chunkArtifact, type RawChunk } from './chunks.js';

/**
 * ArtifactRegistry — the spine that every Jarvis-owned artifact
 * registers into. Backed by SQLite (jarvis.sqlite tables: artifacts,
 * artifact_chunks, artifact_links) + FTS5 (artifact_fts virtual
 * table) + sqlite-vec (artifact_embeddings virtual table).
 *
 * Two write paths land here:
 *   1. In-process upsert from store-level code (meeting-recorder,
 *      quick-note, goals, etc.) via ctx.registerArtifact.
 *   2. Out-of-band chokidar watchers for markdown directories
 *      (notes/, briefings/) where the user might edit by hand.
 *
 * Read surface (exposed to the agent via MCP tools):
 *   - search() — hybrid lexical + semantic with rerank
 *   - list()   — kind / project / since filters
 *   - read()   — full content + links
 *   - walk()   — graph traversal up to depth N
 *
 * All methods are synchronous unless they need the embedding worker
 * (upsert touches the worker async; reads are sync).
 */

interface LinkInputRow {
  src_id: string;
  dst_id: string;
  kind: string;
  created_at: number;
}

interface ArtifactRow {
  id: string;
  kind: string;
  title: string;
  project: string | null;
  path: string | null;
  url: string | null;
  frontmatter_json: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
}

/**
 * Upsert an artifact + replace its chunks + replace its outgoing links
 * + queue an embedding refresh.
 *
 * Idempotent: calling with the same id twice updates in place.
 * `links` is treated as the complete set — passing an empty array
 * drops all outgoing links from this artifact.
 *
 * Embedding work is fire-and-forget. The FTS5 + chunks tables get the
 * lexical hit immediately; the vector embedding lands a beat later
 * once the worker returns. Callers don't need to await.
 */
export async function upsertArtifact(input: ArtifactInput): Promise<void> {
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  const db = getDb();

  const chunks = chunkArtifact(input.content ?? '', input.title);
  const frontmatter = input.frontmatter
    ? JSON.stringify(input.frontmatter)
    : null;

  // Atomically replace the artifact row + its chunks + its links.
  const tx = db.transaction(() => {
    // Upsert artifact row.
    db.prepare(
      `INSERT INTO artifacts
        (id, kind, title, project, path, url, frontmatter_json, created_at, updated_at, archived)
       VALUES
        (@id, @kind, @title, @project, @path, @url, @frontmatter_json, @createdAt, @updatedAt, 0)
       ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        project = excluded.project,
        path = excluded.path,
        url = excluded.url,
        frontmatter_json = excluded.frontmatter_json,
        updated_at = excluded.updated_at,
        archived = 0`,
    ).run({
      id: input.id,
      kind: input.kind,
      title: input.title.slice(0, 500),
      project: input.project ?? null,
      path: input.path ?? null,
      url: input.url ?? null,
      frontmatter_json: frontmatter,
      createdAt,
      updatedAt: now,
    });

    // Replace chunks (and via FK CASCADE + the FTS triggers, the FTS
    // rows too). sqlite-vec rows we wipe explicitly below.
    if (isVecAvailable()) {
      db.prepare(
        `DELETE FROM artifact_embeddings WHERE chunk_id IN (
          SELECT id FROM artifact_chunks WHERE artifact_id = ?
        )`,
      ).run(input.id);
    }
    db.prepare(`DELETE FROM artifact_chunks WHERE artifact_id = ?`).run(input.id);
    const insertChunk = db.prepare(
      `INSERT INTO artifact_chunks (id, artifact_id, ord, heading, content)
       VALUES (@id, @artifactId, @ord, @heading, @content)`,
    );
    for (const c of chunks) {
      insertChunk.run({
        id: chunkId(input.id, c.ord),
        artifactId: input.id,
        ord: c.ord,
        heading: c.heading,
        content: c.content,
      });
    }

    // Replace outgoing links.
    db.prepare(`DELETE FROM artifact_links WHERE src_id = ?`).run(input.id);
    if (input.links && input.links.length > 0) {
      const insertLink = db.prepare(
        `INSERT OR IGNORE INTO artifact_links (src_id, dst_id, kind, created_at)
         VALUES (@src_id, @dst_id, @kind, @created_at)`,
      );
      for (const link of input.links) {
        const row: LinkInputRow = {
          src_id: input.id,
          dst_id: link.to,
          kind: link.kind,
          created_at: now,
        };
        insertLink.run(row);
      }
    }
  });
  tx();

  // Fire-and-forget embedding refresh. Errors swallowed — semantic
  // search just won't find this artifact until next attempt.
  if (isVecAvailable()) {
    void refreshEmbeddings(input.id, chunks).catch((err) => {
      console.warn(
        `[artifacts] embedding refresh failed for ${input.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}

async function refreshEmbeddings(
  artifactId: string,
  chunks: RawChunk[],
): Promise<void> {
  if (chunks.length === 0) return;
  // Embed the full chunk content; prefix with heading for context
  // when the heading carries meaning (## Action items, etc.).
  const texts = chunks.map((c) =>
    c.heading ? `${c.heading}\n\n${c.content}` : c.content,
  );
  const vectors = await embed(texts);
  if (vectors.length === 0) return;
  const db = getDb();
  // The embed call is async, so two concurrent upserts of the same
  // artifact can race: upsert#1 commits its tx (deletes old
  // embeddings, inserts new chunks), fires embed worker; before that
  // returns, upsert#2 commits its tx (same deletes/inserts). Now
  // when upsert#1's vectors arrive they collide with whatever
  // upsert#2 already wrote — INSERT throws UNIQUE constraint.
  //
  // sqlite-vec's vec0 doesn't support ON CONFLICT, so we do an
  // explicit DELETE-then-INSERT inside the embedding tx, and key
  // the whole thing on the chunk ids we're about to write. Whichever
  // upsert finishes embedding last wins for those specific chunks.
  const tx = db.transaction(() => {
    const del = db.prepare(
      `DELETE FROM artifact_embeddings WHERE chunk_id = ?`,
    );
    const insert = db.prepare(
      `INSERT INTO artifact_embeddings (chunk_id, embedding)
       VALUES (?, ?)`,
    );
    for (let i = 0; i < chunks.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      const id = chunkId(artifactId, chunks[i]!.ord);
      del.run(id);
      insert.run(
        id,
        Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
      );
    }
  });
  tx();
}

function chunkId(artifactId: string, ord: number): string {
  return `${artifactId}::${ord}`;
}

export function deleteArtifact(id: string): boolean {
  const db = getDb();
  // Cascade handles chunks (and via the FTS trigger, the FTS rows).
  // Vec rows we wipe explicitly first since they aren't on a FK.
  const tx = db.transaction(() => {
    if (isVecAvailable()) {
      db.prepare(
        `DELETE FROM artifact_embeddings WHERE chunk_id IN (
          SELECT id FROM artifact_chunks WHERE artifact_id = ?
        )`,
      ).run(id);
    }
    db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
  });
  tx();
  return true;
}

export function archiveArtifact(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE artifacts SET archived = 1, updated_at = ? WHERE id = ?`)
    .run(Date.now(), id);
  return res.changes > 0;
}

export function readArtifact(id: string): ArtifactFull | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
    | ArtifactRow
    | undefined;
  if (!row) return null;
  const chunks = db
    .prepare(
      `SELECT heading, content FROM artifact_chunks WHERE artifact_id = ? ORDER BY ord ASC`,
    )
    .all(id) as Array<{ heading: string | null; content: string }>;
  const content = chunks
    .map((c) => (c.heading ? `${c.heading}\n\n${c.content}` : c.content))
    .join('\n\n');
  const linksOut = db
    .prepare(
      `SELECT dst_id AS to_id, kind FROM artifact_links WHERE src_id = ?`,
    )
    .all(id) as Array<{ to_id: string; kind: string }>;
  const linksIn = db
    .prepare(
      `SELECT src_id AS from_id, kind FROM artifact_links WHERE dst_id = ?`,
    )
    .all(id) as Array<{ from_id: string; kind: string }>;
  return {
    ...rowToSummary(row),
    frontmatter: row.frontmatter_json ? JSON.parse(row.frontmatter_json) : null,
    content,
    linksOut: linksOut.map((l) => ({ to: l.to_id, kind: l.kind })),
    linksIn: linksIn.map((l) => ({ from: l.from_id, kind: l.kind })),
  };
}

export interface ListArtifactsOpts {
  kind?: ArtifactKind | ArtifactKind[];
  project?: string;
  since?: number;
  limit?: number;
}

export function listArtifacts(opts: ListArtifactsOpts = {}): ArtifactSummary[] {
  const db = getDb();
  const where: string[] = ['archived = 0'];
  const params: Record<string, unknown> = {};
  if (opts.kind) {
    const kinds = Array.isArray(opts.kind) ? opts.kind : [opts.kind];
    where.push(
      `kind IN (${kinds.map((_, i) => `@k${i}`).join(', ')})`,
    );
    kinds.forEach((k, i) => {
      params[`k${i}`] = k;
    });
  }
  if (opts.project) {
    where.push(`project = @project`);
    params.project = opts.project;
  }
  if (typeof opts.since === 'number') {
    where.push(`updated_at >= @since`);
    params.since = opts.since;
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const sql = `SELECT * FROM artifacts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(params) as ArtifactRow[];
  return rows.map(rowToSummary);
}

/**
 * Walk outgoing + incoming links up to `depth` hops from `id`. Used
 * by the agent's `walk_artifact_graph` MCP tool to answer "show me
 * everything related to this meeting".
 *
 * BFS — caps total visited nodes at 64 so a hub artifact doesn't
 * return a huge graph.
 */
export function walkArtifactGraph(
  id: string,
  depth = 1,
  kinds?: ArtifactKind[],
): ArtifactGraphSnapshot | null {
  const db = getDb();
  const root = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
    | ArtifactRow
    | undefined;
  if (!root) return null;
  const kindFilter = kinds && kinds.length > 0 ? new Set(kinds) : null;
  const visited = new Set<string>([id]);
  const queue: Array<{ id: string; d: number }> = [{ id, d: 0 }];
  const nodes: ArtifactSummary[] = [rowToSummary(root)];
  const edges: ArtifactGraphEdge[] = [];
  const MAX_NODES = 64;
  while (queue.length > 0 && nodes.length < MAX_NODES) {
    const head = queue.shift()!;
    if (head.d >= depth) continue;
    const outRows = db
      .prepare(
        `SELECT src_id, dst_id, kind FROM artifact_links WHERE src_id = ? OR dst_id = ?`,
      )
      .all(head.id, head.id) as Array<{
      src_id: string;
      dst_id: string;
      kind: string;
    }>;
    for (const row of outRows) {
      edges.push({ src: row.src_id, dst: row.dst_id, kind: row.kind });
      const neighbour = row.src_id === head.id ? row.dst_id : row.src_id;
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      const nb = db
        .prepare(`SELECT * FROM artifacts WHERE id = ?`)
        .get(neighbour) as ArtifactRow | undefined;
      if (!nb) continue;
      if (kindFilter && !kindFilter.has(nb.kind)) continue;
      nodes.push(rowToSummary(nb));
      queue.push({ id: nb.id, d: head.d + 1 });
      if (nodes.length >= MAX_NODES) break;
    }
  }
  return { root: rowToSummary(root), nodes, edges };
}

function rowToSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    project: row.project,
    path: row.path,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Return how many artifacts of each kind are indexed. Used for tray
 *  status + the backfill progress bar. */
export function countByKind(): Array<{ kind: string; count: number }> {
  return getDb()
    .prepare(
      `SELECT kind, COUNT(*) AS count FROM artifacts WHERE archived = 0 GROUP BY kind ORDER BY count DESC`,
    )
    .all() as Array<{ kind: string; count: number }>;
}

/** Every explicit link in the substrate. Used by the /memory graph
 *  view's edge layer. Cheap (~hundreds of rows). */
export function listAllLinks(): ArtifactGraphEdge[] {
  return getDb()
    .prepare(`SELECT src_id AS src, dst_id AS dst, kind FROM artifact_links`)
    .all() as ArtifactGraphEdge[];
}

/**
 * Find pairs of artifacts whose embedding cosine similarity is above
 * `threshold`. Used by the /memory graph's "semantic neighbours"
 * overlay — surfaces "this meeting clusters with these notes even
 * though nothing explicitly links them" relationships.
 *
 * For each chunk, query the top-k nearest neighbours; emit a
 * deduplicated set of (src_artifact, dst_artifact, similarity)
 * triples. Same-artifact pairs are skipped. Cosine similarity is
 * `1 - distance` (sqlite-vec returns L2 cosine distance, in [0, 2]).
 *
 * Capped at `maxPerArtifact * artifactCount / 2` total edges so a
 * hub artifact doesn't produce a hairball.
 */
export function semanticNeighbors(
  threshold = 0.7,
  k = 5,
): Array<{ src: string; dst: string; similarity: number }> {
  if (!isVecAvailable()) return [];
  const db = getDb();
  // Pull all chunks + their parent artifact so we can dedupe at the
  // artifact level even when one chunk matches multiple of another
  // artifact's chunks.
  type Row = {
    src_chunk: string;
    src_artifact: string;
    dst_chunk: string;
    dst_artifact: string;
    distance: number;
  };
  // sqlite-vec's KNN syntax needs the query embedding inline. We
  // self-join the embeddings table: for each chunk's vector, find
  // the k nearest OTHER vectors. Done as a single statement to avoid
  // per-chunk round-trips.
  let rows: Row[];
  try {
    rows = db
      .prepare(
        `WITH all_chunks AS (
           SELECT id, artifact_id FROM artifact_chunks
         )
         SELECT
           src.id AS src_chunk,
           src.artifact_id AS src_artifact,
           knn.chunk_id AS dst_chunk,
           dst.artifact_id AS dst_artifact,
           knn.distance AS distance
         FROM all_chunks src
         JOIN artifact_embeddings src_e ON src_e.chunk_id = src.id
         CROSS JOIN LATERAL (
           SELECT chunk_id, distance
           FROM artifact_embeddings
           WHERE embedding MATCH src_e.embedding AND k = ?
           ORDER BY distance
         ) knn
         JOIN artifact_chunks dst ON dst.id = knn.chunk_id
         WHERE src.artifact_id != dst.artifact_id`,
      )
      .all(k + 1) as Row[];
  } catch (err) {
    // CROSS JOIN LATERAL may not be supported in all sqlite-vec
    // versions; fall back to a procedural Float32 round-trip.
    console.warn('[artifacts:vec] LATERAL KNN failed, falling back', err);
    return semanticNeighborsProcedural(threshold, k);
  }

  // Dedupe at artifact level — keep max similarity for each unique
  // unordered pair.
  const best = new Map<string, { src: string; dst: string; similarity: number }>();
  for (const r of rows) {
    const a = r.src_artifact;
    const b = r.dst_artifact;
    if (a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}|${hi}`;
    // sqlite-vec cosine distance: 1 - cos. Similarity = 1 - distance.
    const sim = 1 - r.distance;
    if (sim < threshold) continue;
    const existing = best.get(key);
    if (!existing || sim > existing.similarity) {
      best.set(key, { src: lo, dst: hi, similarity: sim });
    }
  }
  return Array.from(best.values()).sort(
    (a, b) => b.similarity - a.similarity,
  );
}

/** Procedural fallback when the SQL-side LATERAL KNN doesn't run.
 *  Iterates each chunk in JS, makes one KNN call per chunk. Slower
 *  for large corpora but correct. */
function semanticNeighborsProcedural(
  threshold: number,
  k: number,
): Array<{ src: string; dst: string; similarity: number }> {
  const db = getDb();
  type ChunkVec = { chunk_id: string; artifact_id: string; embedding: Buffer };
  const chunks = db
    .prepare(
      `SELECT c.id AS chunk_id, c.artifact_id AS artifact_id, e.embedding AS embedding
       FROM artifact_chunks c JOIN artifact_embeddings e ON e.chunk_id = c.id`,
    )
    .all() as ChunkVec[];
  const knnStmt = db.prepare(
    `SELECT chunk_id, distance FROM artifact_embeddings
     WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
  );
  const chunkMeta = new Map(chunks.map((c) => [c.chunk_id, c.artifact_id]));
  const best = new Map<string, { src: string; dst: string; similarity: number }>();
  for (const c of chunks) {
    const hits = knnStmt.all(c.embedding, k + 1) as Array<{
      chunk_id: string;
      distance: number;
    }>;
    for (const h of hits) {
      const dstArt = chunkMeta.get(h.chunk_id);
      if (!dstArt || dstArt === c.artifact_id) continue;
      const sim = 1 - h.distance;
      if (sim < threshold) continue;
      const [lo, hi] =
        c.artifact_id < dstArt ? [c.artifact_id, dstArt] : [dstArt, c.artifact_id];
      const key = `${lo}|${hi}`;
      const existing = best.get(key);
      if (!existing || sim > existing.similarity) {
        best.set(key, { src: lo, dst: hi, similarity: sim });
      }
    }
  }
  return Array.from(best.values()).sort(
    (a, b) => b.similarity - a.similarity,
  );
}
