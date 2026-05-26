import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  InboxItem,
  TaskSummary,
  TrayMenuState,
} from '@shared/types';

import type { InboxStore } from './inbox.js';
import type { ProjectStore } from './projects.js';
import type { TaskRunner } from './task-runner.js';

const execFileAsync = promisify(execFile);

/**
 * Ambient user context — temporal + spatial + situational data prepended to
 * every task's system prompt. The agent shouldn't have to ask "what time is
 * it" or "what project are you on" — it should just know.
 *
 * Providers are pluggable: built-ins handle time / projects / active scope /
 * recent activity; modules can register additional providers (calendar,
 * currently-open app, weather, anything) via `ModuleContext.registerContextProvider`.
 *
 * Each provider returns a markdown line (or null to skip). Order in the
 * registry is the order in the output, so register the most-important
 * providers first.
 */
export interface UserContextProvider {
  /** Stable identifier — used to dedupe + log. */
  name: string;
  /** Build the provider's markdown line(s). Return null to skip this turn. */
  build(): Promise<string | null> | string | null;
}

/**
 * How long a built context block stays valid before we rebuild it.
 * Most providers read RAM-cheap data; the value mostly changes on
 * the minute boundary (time provider) or on infrequent events
 * (tasks finishing, inbox updating). 5 seconds is plenty fresh
 * for any single user interaction while saving real work when
 * multiple tasks fire in the same tick (autopilot pass + manual
 * palette prompt + work-awareness loop overlapping).
 */
const BUILD_CACHE_TTL_MS = 5_000;

export class UserContextStore {
  private providers: UserContextProvider[] = [];
  private activeProject: string | null = null;
  /** Memoised build() output. Invalidated by TTL or
   *  invalidateCache() — modules that mutate context-driving state
   *  can call invalidateCache() to force a fresh build on the next
   *  task launch (e.g. when active project changes). */
  private cached: { result: string; ts: number } | null = null;

  register(provider: UserContextProvider): void {
    // Replace by name if re-registered — lets modules update their provider
    // without leaking duplicates after a hot reload.
    const i = this.providers.findIndex((p) => p.name === provider.name);
    if (i >= 0) this.providers[i] = provider;
    else this.providers.push(provider);
    // Provider set changed → blow the cache so the new shape lands.
    this.cached = null;
  }

  unregister(name: string): void {
    const i = this.providers.findIndex((p) => p.name === name);
    if (i >= 0) this.providers.splice(i, 1);
    this.cached = null;
  }

  setActiveProject(name: string | null): void {
    if (this.activeProject !== name) this.cached = null;
    this.activeProject = name;
  }

  getActiveProject(): string | null {
    return this.activeProject;
  }

  /** Force the next build() to refetch. Useful after wholesale
   *  state changes (auth flip, integrations connected) where
   *  several providers' output would shift at once. */
  invalidateCache(): void {
    this.cached = null;
  }

  /**
   * Build the full context block. Empty string if every provider returned
   * null (e.g. fresh install with no projects). Caller usually appends to
   * the system prompt with a "## Current context" header.
   *
   * Hot-path optimised:
   *   - **Parallel**: providers run via Promise.all (was serial).
   *     Saves ~N × providerCost on every launch.
   *   - **Cached**: result memoised for BUILD_CACHE_TTL_MS. Back-to-back
   *     launches (autopilot pass + manual command + ambient loop) reuse
   *     the same block. Cache invalidates naturally on TTL OR via
   *     invalidateCache() when wholesale state changes.
   */
  async build(): Promise<string> {
    const cached = this.cached;
    if (cached && Date.now() - cached.ts < BUILD_CACHE_TTL_MS) {
      return cached.result;
    }
    const settled = await Promise.allSettled(
      this.providers.map(async (p) => ({ name: p.name, out: await p.build() })),
    );
    const lines: string[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        const { out } = r.value;
        if (out && out.trim()) lines.push(out.trim());
      } else {
        // A misbehaving provider must not block the task launch — log
        // and skip. Keeps the substrate resilient as third-party
        // providers come and go.
        console.warn(`UserContext provider failed:`, r.reason);
      }
    }
    const result = lines.join('\n');
    this.cached = { result, ts: Date.now() };
    return result;
  }
}

// ─── Built-in providers ──────────────────────────────────────────────────────

/**
 * Day name + ISO date + HH:MM + timezone abbreviation. Always available;
 * always first in the block. Recomputed on every task launch so long-running
 * sessions don't go too stale (the agent can still call `date` for fresh
 * time mid-task).
 */
export const timeProvider: UserContextProvider = {
  name: 'time',
  build() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const day = now.toLocaleDateString(undefined, { weekday: 'long' });
    const iso = now.toISOString().slice(0, 10);
    const hhmm = now.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `- Now: ${day} ${iso}, ${hhmm} (${tz})`;
  },
};

/** Current active project (the scope picker selection). Null if no scope. */
export function activeProjectProvider(store: UserContextStore): UserContextProvider {
  return {
    name: 'active-project',
    build() {
      const active = store.getActiveProject();
      return active ? `- Active project scope: ${active}` : null;
    },
  };
}

/**
 * When a project scope is active, load that project's profile.md
 * (built by the project-profile skill) and surface it inline. Lets
 * any task scoped to "csai" or "hivecore" start with full project
 * context — what the codebase is, conventions, recent direction —
 * without re-deriving it every time.
 *
 * Capped at ~3KB so long profiles don't blow out the task's prompt
 * budget. Profile not present / dir missing → silent skip.
 */
export function activeProjectProfileProvider(
  store: UserContextStore,
  projects: ProjectStore,
): UserContextProvider {
  return {
    name: 'active-project-profile',
    build() {
      const active = store.getActiveProject();
      if (!active) return null;
      const def = projects.resolve(active);
      if (!def) return null;
      const slug = def.name
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const path = join(
        homedir(),
        '.jarvis',
        'projects',
        slug,
        'memory',
        'profile.md',
      );
      if (!existsSync(path)) return null;
      let body: string;
      try {
        body = readFileSync(path, 'utf8');
      } catch {
        return null;
      }
      // Trim front matter if present (the renderer cares about it; the
      // agent doesn't need it taking up the budget).
      body = body.replace(/^---\n[\s\S]*?\n---\n+/, '');
      const MAX = 3000;
      const truncated = body.length > MAX ? body.slice(0, MAX) + '\n…' : body;
      return `- Active project profile (${def.name}):\n${truncated}`;
    },
  };
}

/**
 * The user's tracked projects. Lifted verbatim from TaskRunner's previous
 * inline logic — drives "the X project" / fuzzy alias resolution in skills.
 */
export function projectsProvider(projects: ProjectStore): UserContextProvider {
  return {
    name: 'projects',
    build() {
      const all = projects.list();
      if (all.length === 0) return null;
      const lines = all.map((p) => {
        const bits: string[] = [`  - ${p.name}`];
        if (p.aliases.length) bits.push(`(aliases: ${p.aliases.join(', ')})`);
        if (p.repo) bits.push(`repo: ${p.repo}`);
        if (p.path) bits.push(`path: ${p.path}`);
        if (p.description) bits.push(`— ${p.description}`);
        return bits.join(' ');
      });
      return `- Tracked projects (resolve fuzzy references via aliases):\n${lines.join('\n')}`;
    },
  };
}

/**
 * Recent task activity — the last 3 user-launched tasks. Helps the agent
 * realise it's the continuation of recent work ("an hour ago I asked
 * Claude to review PRs, now I want…") AND answers "what did I do
 * yesterday?" / "what did I just run?" without a tool round-trip.
 */
export function recentTaskProvider(runner: TaskRunner): UserContextProvider {
  return {
    name: 'recent-task',
    build() {
      const tasks = runner.list();
      // Filter to user-launched tasks (skip 'external' which is the
      // claude-code-watch mirror — too noisy as context).
      const owned = tasks.filter((t: TaskSummary) => t.origin !== 'external');
      if (owned.length === 0) return null;
      const top = owned.slice(0, 3);
      const lines = top.map((t) => {
        const ageMs = Date.now() - (t.endedAt ?? t.startedAt);
        const ageMin = Math.round(ageMs / 60_000);
        const ageLabel =
          ageMin < 1
            ? 'just now'
            : ageMin < 60
              ? `${ageMin}m ago`
              : ageMin < 60 * 24
                ? `${Math.round(ageMin / 60)}h ago`
                : `${Math.round(ageMin / (60 * 24))}d ago`;
        const title = t.title.length > 60 ? `${t.title.slice(0, 60)}…` : t.title;
        return `  - ${t.status} ${ageLabel}: ${title}`;
      });
      return `- Recent tasks:\n${lines.join('\n')}`;
    },
  };
}

/**
 * Inbox highlights — top items the smart-curate loop flagged + any
 * fire-soon time-pressured items. So the agent answers "who's waiting
 * on me / what's urgent / what should I do next" from cached context.
 *
 * Prefers `source === 'smart'` (the haiku-ranked + annotated picks)
 * when present; otherwise falls back to the top mixed feed sorted by
 * (fireAt soonest, then most recent).
 */
export function inboxHighlightsProvider(
  inbox: InboxStore,
): UserContextProvider {
  return {
    name: 'inbox-highlights',
    build() {
      const all = inbox.list();
      if (all.length === 0) return null;

      const smart = all
        .filter((i) => i.source === 'smart')
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

      const picks: InboxItem[] =
        smart.length > 0
          ? smart.slice(0, 5)
          : all
              .filter((i) => i.source !== 'calendar' && i.source !== 'smart')
              .sort((a, b) => {
                // fireAt-bearing items first, soonest fire wins.
                const fa = a.fireAt ?? Number.POSITIVE_INFINITY;
                const fb = b.fireAt ?? Number.POSITIVE_INFINITY;
                if (fa !== fb) return fa - fb;
                return (b.createdAt ?? 0) - (a.createdAt ?? 0);
              })
              .slice(0, 5);

      if (picks.length === 0) return null;

      const lines = picks.map((i) => {
        const src = i.source.toUpperCase();
        const title = trimTitle(i.title, 60);
        const sub = i.subtitle ? ` (${trimTitle(i.subtitle, 50)})` : '';
        return `  - [${src}] ${title}${sub}`;
      });
      const header =
        smart.length > 0
          ? `- Inbox highlights (smart-curated top ${picks.length}):`
          : `- Inbox top ${picks.length}:`;
      return `${header}\n${lines.join('\n')}`;
    },
  };
}

/**
 * Runtime state — mode + AFK + spend + counts + pinned threads. One block
 * so the agent has the full "cockpit snapshot" without us splitting it
 * into four small providers. Sourced from the tray state getter so it
 * stays in lockstep with what the menu-bar shows.
 */
export function runtimeProvider(
  getStatus: () => TrayMenuState,
): UserContextProvider {
  return {
    name: 'runtime',
    build() {
      let s: TrayMenuState;
      try {
        s = getStatus();
      } catch {
        return null;
      }
      const lines: string[] = [];
      const mode = s.appMode;
      const flags: string[] = [];
      if (s.afk) flags.push('AFK');
      if (s.runningTasks > 0) flags.push(`${s.runningTasks} running`);
      if (s.awaitingReplies > 0) flags.push(`${s.awaitingReplies} awaiting`);
      const flagStr = flags.length ? ` · ${flags.join(' · ')}` : '';
      const spend =
        s.todaySpendUsd > 0
          ? ` · $${s.todaySpendUsd.toFixed(s.todaySpendUsd >= 0.01 ? 2 : 4)} today`
          : '';
      lines.push(`- Jarvis state: ${mode}${flagStr}${spend}`);

      if (s.pinned.length > 0) {
        const pinned = s.pinned
          .slice(0, 5)
          .map((p) => `${p.title}${p.reduced ? ' (reduced)' : ''}`)
          .join('; ');
        lines.push(`- Pinned threads: ${pinned}`);
      }
      return lines.join('\n');
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function trimTitle(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * macOS Focus / Do Not Disturb visibility hint. **Not auto-registered** —
 * reading the actual Focus mode state on modern macOS requires reading a
 * TCC-protected SQLite DB at `~/Library/DoNotDisturb/DB/Assertions.json`,
 * which isn't worth the permission prompt. This provider only checks
 * whether the menu-bar widget is enabled — a weak signal at best.
 *
 * Kept exported so a future module / power-user wiring can opt in via
 * `ctx.registerContextProvider(focusModeProvider)`. Replace with a real
 * Focus-aware implementation when the API is friendlier.
 */
export const focusModeProvider: UserContextProvider = {
  name: 'focus-mode',
  async build() {
    if (process.platform !== 'darwin') return null;
    try {
      const { stdout } = await execFileAsync(
        'defaults',
        ['read', 'com.apple.controlcenter', 'NSStatusItem Visible FocusModes'],
        { timeout: 1500 },
      );
      const visible = stdout.trim() === '1';
      if (!visible) return null;
      return `- Focus widget visible in menu bar (actual Focus state not exposed)`;
    } catch {
      return null;
    }
  },
};
