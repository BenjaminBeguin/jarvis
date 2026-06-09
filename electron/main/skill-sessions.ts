import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Index of the most-recent active SDK session per skill. Powers the
 * pooling that turns N short skill turns into one long conversation,
 * cutting the cold-start cost of re-loading system prompt + skill
 * body + tool inventory on every dispatch.
 *
 * Policy:
 *   - Per-skill, per-origin, per-project. Scoping to active project
 *     keeps cs-ai turns separate from personal turns even when both
 *     fire the same skill.
 *   - Long-lasting by default. POOL_MAX_AGE_MS = 7 days — match
 *     Claude.ai's "your conversation is still there next week"
 *     feel. After 7 days of silence we fork fresh so a stale topic
 *     doesn't accidentally graft onto today's thread.
 *   - Origins that pool: palette, voice, api (Telegram bot, other
 *     module launches). Routines + scheduled-action reminders still
 *     fork their own fresh sessions — their fires are unattended
 *     and shouldn't mix with user-initiated work.
 *   - Turn-bounded at POOL_MAX_TURNS = 200. The SDK auto-compacts
 *     when context fills, so the cap is a soft backstop on
 *     per-session cost climb, not a hard limit. Use forceFresh to
 *     bypass when the user explicitly wants a clean slate.
 *
 * Persisted to ~/.jarvis/skill-sessions.json. Survives restarts so
 * "I was talking to Jarvis about X yesterday — let me continue"
 * works after closing the laptop.
 */

const POOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const POOL_MAX_TURNS = 200;

interface IndexEntry {
  /** SDK session id to resume. Captured from the SDK's init event
   *  after the first turn lands. */
  sdkSessionId: string;
  /** ms epoch of the most-recent turn. Drives the freshness check. */
  lastUsedAt: number;
  /** How many turns have landed on this session. Used to cap reuse
   *  before context bloat starts costing more than the saved cold-
   *  start. */
  turnCount: number;
}

/**
 * Sentinel skillId used for free-text (no-skill) ask pooling. A
 * palette free-text dispatch with this synthetic id pools with
 * other free-text asks under the same model + origin + project,
 * letting the SDK skip cold-start on follow-up questions.
 */
export const FREE_TEXT_BUCKET = '__freetext__';

/** Bucket key — skill + model + origin + project so different threads
 *  don't mix. Model is part of the key so a Sonnet ask can't accidentally
 *  resume a Haiku session (different model on the same conversation
 *  thread = jarring switch in voice). Defaults to '_' when the caller
 *  didn't pin a model — skill-pooled tasks land there since their
 *  model comes from skill frontmatter, not the request. */
function keyFor(
  skillId: string,
  model: string | null | undefined,
  origin: string,
  projectName: string | null | undefined,
): string {
  return `${skillId}|${model ?? '_'}|${origin}|${projectName ?? '_'}`;
}

export interface SkillPoolingDecision {
  /** Session to pass to runner.launch({ resumeSessionId }). Null = fork. */
  resumeSessionId: string | null;
  /** The key the runner should call recordTurn() against once the new
   *  task's sdkSessionId is known. */
  bucketKey: string;
}

export class SkillSessionStore {
  private path: string;
  private index = new Map<string, IndexEntry>();

  constructor(path: string = join(homedir(), '.jarvis', 'skill-sessions.json')) {
    this.path = path;
  }

  init(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return;
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        if (
          typeof v.sdkSessionId === 'string' &&
          typeof v.lastUsedAt === 'number' &&
          typeof v.turnCount === 'number'
        ) {
          this.index.set(key, {
            sdkSessionId: v.sdkSessionId,
            lastUsedAt: v.lastUsedAt,
            turnCount: v.turnCount,
          });
        }
      }
    } catch (err) {
      console.warn('SkillSessionStore: failed to load index:', err);
    }
  }

  /**
   * Decide whether a new launch can resume an active session.
   * Returns the session id to resume (or null to fork) + the bucket key
   * the runner should call recordTurn() against once the new task's
   * sdkSessionId is known.
   *
   * Caller passes `forceFresh: true` to skip pooling (e.g. when the
   * user opts out for a specific dispatch).
   */
  decide(input: {
    /** null = free-text ask (no skill). Pools under FREE_TEXT_BUCKET
     *  scoped by model so different tiers don't graft onto each
     *  other. */
    skillId: string | null | undefined;
    /** Model id for free-text scoping. Ignored for skill pools
     *  (skill frontmatter pins the model). */
    model?: string | null | undefined;
    origin: string;
    projectName: string | null | undefined;
    forceFresh?: boolean;
  }): SkillPoolingDecision | null {
    // Pool user-initiated work AND api-origin dispatches (Telegram
    // bot, other module-launched tasks). Routine + scheduled-action
    // reminders still fork their own fresh sessions — those fires
    // are unattended and shouldn't mix with conversational threads.
    if (
      input.origin !== 'palette' &&
      input.origin !== 'voice' &&
      input.origin !== 'api'
    ) {
      return null;
    }
    const skillSlot = input.skillId ?? FREE_TEXT_BUCKET;
    // Free-text pools include model in the key (Haiku ask shouldn't
    // resume a Sonnet thread); skill pools key on the skillId only
    // (the skill's frontmatter already pins the model, so adding
    // it to the key would just make a single bucket per skill).
    const modelSlot = input.skillId ? null : input.model ?? null;
    const bucketKey = keyFor(
      skillSlot,
      modelSlot,
      input.origin,
      input.projectName,
    );
    if (input.forceFresh) {
      this.index.delete(bucketKey);
      this.persist();
      return { resumeSessionId: null, bucketKey };
    }
    const entry = this.index.get(bucketKey);
    if (!entry) return { resumeSessionId: null, bucketKey };
    const ageMs = Date.now() - entry.lastUsedAt;
    if (ageMs > POOL_MAX_AGE_MS || entry.turnCount >= POOL_MAX_TURNS) {
      this.index.delete(bucketKey);
      this.persist();
      return { resumeSessionId: null, bucketKey };
    }
    return { resumeSessionId: entry.sdkSessionId, bucketKey };
  }

  /**
   * Called by the runner after a turn lands — captures the SDK session
   * id (which may differ from the one we asked to resume if the SDK
   * forked) and bumps turn count. Idempotent: same sessionId on the
   * same bucket just bumps lastUsedAt.
   */
  recordTurn(bucketKey: string, sdkSessionId: string): void {
    const existing = this.index.get(bucketKey);
    if (existing && existing.sdkSessionId === sdkSessionId) {
      this.index.set(bucketKey, {
        ...existing,
        lastUsedAt: Date.now(),
        turnCount: existing.turnCount + 1,
      });
    } else {
      // Fresh session OR session id rotated under us — start the
      // counter over for the new id.
      this.index.set(bucketKey, {
        sdkSessionId,
        lastUsedAt: Date.now(),
        turnCount: 1,
      });
    }
    this.persist();
  }

  /** Explicit user request: drop this skill's pooled session so the
   *  next dispatch starts fresh. Used by a future "fresh /<skill>"
   *  palette flag or a "Start new session" affordance in the UI. */
  fork(input: {
    skillId: string;
    model?: string | null | undefined;
    origin: string;
    projectName: string | null | undefined;
  }): void {
    const key = keyFor(
      input.skillId,
      input.model ?? null,
      input.origin,
      input.projectName,
    );
    if (this.index.delete(key)) this.persist();
  }

  /** For debugging / a future Settings affordance. */
  list(): Array<{ key: string; entry: IndexEntry }> {
    return [...this.index.entries()].map(([key, entry]) => ({ key, entry }));
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const obj: Record<string, IndexEntry> = {};
      for (const [k, v] of this.index) obj[k] = v;
      writeFileSync(this.path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.warn('SkillSessionStore: failed to persist index:', err);
    }
  }
}
