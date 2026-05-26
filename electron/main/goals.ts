import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { nanoid } from 'nanoid';

/**
 * Persistent multi-day commitments — the "I want to ship X by Y"
 * shape that doesn't fit into one-shot reminders or daily routines.
 *
 * A Goal carries:
 *   - title + body (the what + the why)
 *   - deadline (optional but encouraged — drives nudges)
 *   - status (active | done | abandoned)
 *   - progressLog: append-only timestamped entries the
 *     goal-progress skill (or the user) adds as work happens
 *   - relatedKeywords: matchers used by the progress skill to
 *     associate observed activity (PR titles, commit messages,
 *     meeting transcripts) with the goal
 *
 * Persisted to ~/.jarvis/goals.json. Surfaced into the unified
 * Inbox under source='goals' so they triage alongside PRs /
 * Slack / etc. The goal-progress skill runs daily, reads recent
 * activity, and appends progress entries when it sees relevant
 * signal.
 *
 * Electron-free; same shape works in a future server mode.
 */

export type GoalStatus = 'active' | 'done' | 'abandoned';

export interface GoalProgressEntry {
  /** ms epoch when this entry was added. */
  at: number;
  /** Free-text note describing what happened. */
  note: string;
  /** Where the signal came from — 'user' (manual update),
   *  'goal-progress' (auto-skill), or a specific source like
   *  'pr-merge', 'meeting'. */
  source: string;
  /** Optional URL / file path linking to the underlying signal. */
  url?: string;
}

export interface Goal {
  id: string;
  title: string;
  body: string;
  /** ms epoch deadline. null = open-ended / no hard deadline. */
  deadline: number | null;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  /** Words / phrases the goal-progress skill uses to match activity. */
  relatedKeywords: string[];
  progressLog: GoalProgressEntry[];
  /** Optional project alias scope. Goals tagged to a project show
   *  in that project's view + bias the progress skill's search. */
  project?: string | null;
}

const PATH = join(homedir(), '.jarvis', 'goals.json');

interface StoreFile {
  goals: Goal[];
}

function defaultStore(): StoreFile {
  return { goals: [] };
}

export class GoalStore extends EventEmitter {
  private goals: Goal[] = [];
  private loaded = false;

  init(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(PATH)) {
      this.goals = [];
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(PATH, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && Array.isArray((raw as StoreFile).goals)) {
        this.goals = (raw as StoreFile).goals.filter(isGoal);
      }
    } catch (err) {
      console.warn('[goals] failed to load store:', err);
      this.goals = [];
    }
  }

  list(): Goal[] {
    if (!this.loaded) this.init();
    return [...this.goals];
  }

  /** Active goals only, soonest-deadline first (no-deadline last). */
  listActive(): Goal[] {
    return this.list()
      .filter((g) => g.status === 'active')
      .sort((a, b) => {
        const da = a.deadline ?? Number.POSITIVE_INFINITY;
        const db = b.deadline ?? Number.POSITIVE_INFINITY;
        return da - db;
      });
  }

  get(id: string): Goal | null {
    return this.list().find((g) => g.id === id) ?? null;
  }

  create(input: {
    title: string;
    body?: string;
    deadline?: number | null;
    relatedKeywords?: string[];
    project?: string | null;
  }): Goal {
    if (!this.loaded) this.init();
    const now = Date.now();
    const g: Goal = {
      id: nanoid(10),
      title: input.title.trim(),
      body: (input.body ?? '').trim(),
      deadline: input.deadline ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      relatedKeywords: (input.relatedKeywords ?? []).map((k) => k.trim()).filter(Boolean),
      progressLog: [],
      project: input.project ?? null,
    };
    this.goals.push(g);
    this.persist();
    this.emit('changed', this.list());
    return g;
  }

  appendProgress(id: string, entry: Omit<GoalProgressEntry, 'at'>): Goal | null {
    if (!this.loaded) this.init();
    const idx = this.goals.findIndex((g) => g.id === id);
    if (idx < 0) return null;
    const existing = this.goals[idx]!;
    const next: Goal = {
      ...existing,
      progressLog: [
        ...existing.progressLog,
        { ...entry, at: Date.now() },
      ],
      updatedAt: Date.now(),
    };
    this.goals[idx] = next;
    this.persist();
    this.emit('changed', this.list());
    return next;
  }

  setStatus(id: string, status: GoalStatus): Goal | null {
    if (!this.loaded) this.init();
    const idx = this.goals.findIndex((g) => g.id === id);
    if (idx < 0) return null;
    const existing = this.goals[idx]!;
    const next: Goal = { ...existing, status, updatedAt: Date.now() };
    this.goals[idx] = next;
    this.persist();
    this.emit('changed', this.list());
    return next;
  }

  remove(id: string): boolean {
    if (!this.loaded) this.init();
    const before = this.goals.length;
    this.goals = this.goals.filter((g) => g.id !== id);
    if (this.goals.length === before) return false;
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(PATH), { recursive: true });
      const payload: StoreFile = { goals: this.goals };
      writeFileSync(PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.warn('[goals] failed to persist:', err);
    }
  }
}

function isGoal(v: unknown): v is Goal {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.id === 'string' &&
    typeof g.title === 'string' &&
    typeof g.createdAt === 'number' &&
    Array.isArray(g.progressLog) &&
    (g.status === 'active' || g.status === 'done' || g.status === 'abandoned')
  );
}
