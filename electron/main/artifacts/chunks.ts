/**
 * Chunk a long artifact body for indexing. Strategy:
 *   - Split on ## / ### markdown headings (preserve heading as a
 *     contextual tag for snippet display).
 *   - Cap each chunk at MAX_CHUNK_CHARS — overrun gets split on the
 *     nearest paragraph break.
 *   - Short artifacts (< MIN_CHUNK_CHARS or with no headings) get a
 *     single chunk with no heading.
 *
 * Per-chunk granularity matters for two things:
 *   1. FTS5 + vector hits highlight a relevant section, not the whole
 *      30-min transcript.
 *   2. Embedding the WHOLE transcript would exceed MiniLM's 256-token
 *      window — chunks fit, embed cleanly, KNN works.
 */

export interface RawChunk {
  ord: number;
  heading: string | null;
  content: string;
}

const MAX_CHUNK_CHARS = 1500;
const MIN_CHUNK_CHARS = 80;

export function chunkArtifact(body: string, title: string): RawChunk[] {
  const trimmed = (body ?? '').trim();
  if (!trimmed) {
    return [{ ord: 0, heading: null, content: title || '' }];
  }
  if (trimmed.length <= MAX_CHUNK_CHARS) {
    return [{ ord: 0, heading: null, content: trimmed }];
  }

  // Pass 1: split on level-2 / level-3 markdown headings. Keep the
  // heading line as the chunk's `heading` field (preserved for
  // snippet context), and the body that follows it.
  const lines = trimmed.split('\n');
  const sections: Array<{ heading: string | null; content: string }> = [];
  let current: { heading: string | null; content: string } = {
    heading: null,
    content: '',
  };
  for (const line of lines) {
    const headMatch = /^(#{2,3})\s+(.+)$/.exec(line);
    if (headMatch) {
      if (current.content.trim() || current.heading) sections.push(current);
      current = { heading: line.trim(), content: '' };
    } else {
      current.content += (current.content ? '\n' : '') + line;
    }
  }
  if (current.content.trim() || current.heading) sections.push(current);

  // Pass 2: cap each section at MAX_CHUNK_CHARS. Overrun splits on
  // nearest paragraph break (blank line) or falls back to a hard cut.
  const chunks: RawChunk[] = [];
  let ord = 0;
  for (const sec of sections) {
    const cleaned = sec.content.trim();
    if (!cleaned && !sec.heading) continue;
    if (cleaned.length <= MAX_CHUNK_CHARS) {
      chunks.push({ ord: ord++, heading: sec.heading, content: cleaned });
      continue;
    }
    let remaining = cleaned;
    let chunkIdx = 0;
    while (remaining.length > MAX_CHUNK_CHARS) {
      let cut = remaining.lastIndexOf('\n\n', MAX_CHUNK_CHARS);
      if (cut < MIN_CHUNK_CHARS) cut = remaining.lastIndexOf('\n', MAX_CHUNK_CHARS);
      if (cut < MIN_CHUNK_CHARS) cut = MAX_CHUNK_CHARS;
      const heading =
        chunkIdx === 0 ? sec.heading : sec.heading ? `${sec.heading} (cont.)` : null;
      chunks.push({ ord: ord++, heading, content: remaining.slice(0, cut).trim() });
      remaining = remaining.slice(cut).trim();
      chunkIdx++;
    }
    if (remaining) {
      const heading = sec.heading ? `${sec.heading} (cont.)` : null;
      chunks.push({ ord: ord++, heading, content: remaining });
    }
  }
  if (chunks.length === 0) {
    chunks.push({ ord: 0, heading: null, content: trimmed.slice(0, MAX_CHUNK_CHARS) });
  }
  return chunks;
}
