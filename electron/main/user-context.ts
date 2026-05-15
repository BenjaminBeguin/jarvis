import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { TaskSummary } from '@shared/types';

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

export class UserContextStore {
  private providers: UserContextProvider[] = [];
  private activeProject: string | null = null;

  register(provider: UserContextProvider): void {
    // Replace by name if re-registered — lets modules update their provider
    // without leaking duplicates after a hot reload.
    const i = this.providers.findIndex((p) => p.name === provider.name);
    if (i >= 0) this.providers[i] = provider;
    else this.providers.push(provider);
  }

  setActiveProject(name: string | null): void {
    this.activeProject = name;
  }

  getActiveProject(): string | null {
    return this.activeProject;
  }

  /**
   * Build the full context block. Empty string if every provider returned
   * null (e.g. fresh install with no projects). Caller usually appends to
   * the system prompt with a "## Current context" header.
   */
  async build(): Promise<string> {
    const lines: string[] = [];
    for (const p of this.providers) {
      try {
        const out = await p.build();
        if (out && out.trim()) lines.push(out.trim());
      } catch (err) {
        // A misbehaving provider must not block the task launch — log and
        // skip. Keeps the substrate resilient as third-party providers
        // come and go.
        console.warn(`UserContext provider "${p.name}" failed:`, err);
      }
    }
    return lines.join('\n');
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
 * Last completed/running task. Helps the agent realise it's the continuation
 * of recent work ("an hour ago I asked Claude to review PRs, now I want…").
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
      const last = owned[0];
      if (!last) return null;
      const ageMs = Date.now() - (last.endedAt ?? last.startedAt);
      const ageMin = Math.round(ageMs / 60_000);
      const ageLabel =
        ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)}h ago`;
      const title = last.title.length > 60 ? `${last.title.slice(0, 60)}…` : last.title;
      return `- Last task (${last.status}, ${ageLabel}): ${title}`;
    },
  };
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
