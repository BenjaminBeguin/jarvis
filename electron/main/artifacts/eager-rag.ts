import type { ArtifactSearchHit } from '@shared/types';

import { searchArtifacts } from './search.js';

/**
 * Eager retrieval-augmented generation — runs `search_artifacts`
 * against the launching prompt and returns the top hits formatted
 * for inclusion in the system prompt.
 *
 * Difference from the `recentArtifactsProvider`:
 *   - Recent provider = "what's in your index right now" (last 24h
 *     headline, prompt-agnostic).
 *   - Eager RAG = "what's relevant to THIS specific question"
 *     (semantically + lexically ranked against the prompt).
 *
 * Skip heuristic: only retrieve for prompts that look like memory
 * queries (questions, "find / show / summarize", past-tense
 * references, etc.). Imperative shell-shaped prompts and skill
 * dispatches get nothing — eager retrieval would just inject
 * unrelated noise.
 *
 * LRU cache: 60s TTL keyed by normalised prompt. Lets a re-run of
 * the same question skip the search worker round-trip.
 */

// 5min TTL keeps a typical "ask burst" warm — users tend to follow up
// on the same topic within a few minutes. 32-entry LRU keeps memory
// bounded; older keys evict naturally. Cache is per-prompt so a
// follow-up question still re-retrieves with fresh signal.
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 32;
const SNIPPET_CHARS = 220;
const DEFAULT_LIMIT = 5;

interface CacheEntry {
  hits: ArtifactSearchHit[];
  at: number;
}

const cache = new Map<string, CacheEntry>();

function normalise(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Decide whether `prompt` looks like a memory query worth pre-
 * retrieving. Returns false for shell-shaped, skill-dispatched, or
 * very short prompts.
 *
 * Conservative default — when in doubt, don't retrieve. The agent
 * can still call `search_artifacts` mid-turn for false negatives;
 * false positives waste tokens AND latency.
 */
export function shouldEagerRetrieve(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 12) return false;
  // Skill-pinned dispatches have curated system prompts; eager RAG
  // would just be context noise on top.
  if (/^\/\w+/.test(trimmed)) return false;
  // Trivial factual asks the user-context block already answers (time,
  // date, project, AFK, runtime state). Pre-retrieving for these
  // injects irrelevant snippets AND primes the agent to elaborate on
  // memory instead of just reading its system prompt. Skip them so
  // "what time is it?" stays a ~300ms Haiku round-trip.
  if (
    /^(what\s+(time|day|date|year|month|hour)|what(\s+is|s|'s)?\s+(today|tonight|tomorrow|the\s+(time|date|day|year))|what\s+project|am\s+i\s+(afk|paused|on))\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  // Verbal-trigger imperatives ("show me X", "tell me about Y") —
  // those ARE memory queries.
  if (
    /^(show\s+me|tell\s+me|find\s+(me\s+)?|search\s+(for\s+)?|look\s+up|recap|summari[sz]e)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Pure-imperative shell-shaped commands.
  if (
    /^(commit|push|merge|open|run|write|create|delete|fix|add|update|build|deploy|install|remove|rename|move|copy|edit|refactor|format|lint)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  // Positive memory-query signals.
  if (/[?]/.test(trimmed)) return true;
  if (/^(what|where|when|why|who|which|how)\b/i.test(trimmed)) return true;
  if (
    /\b(did|do(es)?|is|are|was|were|has|have)\s+(we|i|you|they|the\s+team)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (
    /\bany\s+(update|news|progress|meeting|notes?|signal)\b/i.test(trimmed)
  ) {
    return true;
  }
  if (
    /\b(yesterday|last\s+(week|month|year|meeting|standup|sprint)|previously|earlier|recently|this\s+(week|month|quarter|sprint))\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/\b(remember|recall|discussed|mentioned|talked\s+about)\b/i.test(trimmed)) {
    return true;
  }
  // Default: skip. Better to under-retrieve than to pollute every
  // task's context block with unrelated memory.
  return false;
}

/**
 * Run hybrid search against `prompt` and format the top hits as a
 * markdown block ready to drop into the system prompt. Returns null
 * when the prompt is skipped, when no hits clear the relevance
 * floor, or when the substrate isn't ready.
 */
export async function eagerRetrieve(
  prompt: string,
  activeProject: string | null = null,
  limit: number = DEFAULT_LIMIT,
): Promise<string | null> {
  if (!shouldEagerRetrieve(prompt)) return null;

  const key = `${activeProject ?? ''}|${normalise(prompt)}`;
  const now = Date.now();
  // Drain expired entries opportunistically.
  if (cache.size > CACHE_MAX) {
    for (const [k, v] of cache) {
      if (now - v.at > CACHE_TTL_MS) cache.delete(k);
      if (cache.size <= CACHE_MAX / 2) break;
    }
  }
  const cached = cache.get(key);
  let hits: ArtifactSearchHit[];
  if (cached && now - cached.at < CACHE_TTL_MS) {
    hits = cached.hits;
  } else {
    // Hard budget. The launch path AWAITS this; a slow embed-worker
    // (first-run model download, busy CPU, hung process) cannot be
    // allowed to stall the SDK spawn for 30+ seconds. Better to skip
    // memory injection than to make the user wait. The agent can
    // still call `mcp__jarvis__search_artifacts` mid-turn if it
    // needs context.
    const RETRIEVE_BUDGET_MS = 800;
    try {
      hits = await Promise.race<ArtifactSearchHit[]>([
        searchArtifacts(
          { query: prompt, mode: 'hybrid', limit },
          activeProject,
        ),
        new Promise<ArtifactSearchHit[]>((_, reject) =>
          setTimeout(
            () => reject(new Error('eager-rag budget exceeded')),
            RETRIEVE_BUDGET_MS,
          ),
        ),
      ]);
    } catch (err) {
      // Budget timeout OR worker error — both treated the same.
      // We still kick the background search off so the LRU fills
      // for the next ask; the current launch just proceeds without
      // injected memory.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[eager-rag] skipped: ${msg}`);
      if (msg.includes('budget')) {
        // Don't double-fire if the actual search worker already
        // finished after the race rejected — searchArtifacts'
        // result will eventually populate the worker's own caches.
        // Nothing to cache here for next time; just bail.
      }
      return null;
    }
    cache.set(key, { hits, at: now });
  }
  if (hits.length === 0) return null;

  const lines: string[] = [];
  for (const h of hits) {
    const ageMin = Math.max(0, Math.round((now - h.updatedAt) / 60_000));
    const when =
      ageMin < 60
        ? `${ageMin}m`
        : ageMin < 1440
          ? `${Math.round(ageMin / 60)}h`
          : `${Math.round(ageMin / 1440)}d`;
    const title = h.title.length > 70 ? `${h.title.slice(0, 70)}…` : h.title;
    const snippet = formatSnippet(h.snippet, SNIPPET_CHARS);
    lines.push(`  - [${h.id}] ${title} (${when} ago)`);
    if (snippet) lines.push(`    > ${snippet}`);
  }
  return (
    `- Relevant work memory for this query (auto-retrieved from your artifact catalog — full details via \`mcp__jarvis__read_artifact({id})\`):\n` +
    lines.join('\n')
  );
}

function formatSnippet(raw: string, max: number): string {
  if (!raw) return '';
  // FTS5 snippet wraps matches in « » markers we added; preserve
  // them so the agent sees which terms hit.
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

/** Drop the LRU. Useful in tests + when the user manually rebuilds
 *  the catalog. Not exposed via IPC today. */
export function clearEagerRagCache(): void {
  cache.clear();
}

/**
 * Fire-and-forget cache prewarm. Called by the palette as the user
 * types, so by the time they press Enter the eager-RAG hit is already
 * in the LRU and the launch path resolves it without a search-worker
 * round-trip (saves ~100–200ms of "ask → first token").
 *
 * Errors are swallowed — this is best-effort speed-up, not a critical
 * path. Skipped prompts (shell-shaped, too short, etc.) return
 * immediately.
 */
export function prewarmEagerRag(
  prompt: string,
  activeProject: string | null = null,
): void {
  if (!shouldEagerRetrieve(prompt)) return;
  // Don't await — the caller is a debounced keystroke handler; we
  // just want the LRU populated by the time Enter fires.
  void eagerRetrieve(prompt, activeProject).catch(() => {
    // Swallow: prewarm failures are benign, the real launch path
    // will retry and surface any actual problem.
  });
}
