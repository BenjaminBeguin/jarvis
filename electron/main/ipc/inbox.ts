import { ipcMain, shell } from 'electron';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, normalize, resolve } from 'node:path';

import { IpcChannels } from '@shared/ipc';
import type { InboxSourceSummary } from '@shared/types';

import type { IpcDeps } from './types.js';

/**
 * Static descriptions for the built-in inbox sources. The InboxStore
 * registers each one by name; we pair that with a human-readable
 * label + one-line "what this surfaces" + the right "configure" link
 * so the Settings panel can show them as a real list, not just opaque
 * ids.
 */
const BUILTIN_SOURCE_META: Record<
  string,
  Pick<InboxSourceSummary, 'label' | 'description' | 'configureHint'>
> = {
  reminders: {
    label: 'Reminders',
    description:
      'One-shot reminders + scheduled actions you set. Surfaces when fireAt is near.',
    configureHint: 'reminders',
  },
  'failed-routines': {
    label: 'Failed routines',
    description:
      'Routine tasks that errored on their last run — click to inspect or re-fire.',
    configureHint: 'routines',
  },
  'pr-review': {
    label: 'PR reviews waiting on you',
    description:
      'gh-CLI scan of pull requests where you owe a review. Scope per project in the panel below.',
    configureHint: 'inbox-scope',
  },
  'pr-comments': {
    label: 'Comments on your PRs',
    description:
      "gh-CLI scan of unresolved threads on PRs you opened. Drops out as soon as you reply.",
    configureHint: 'inbox-scope',
  },
  linear: {
    label: 'Linear · needs you',
    description:
      'Driven by the linear-inbox-sync workflow — issues assigned to you and not yet done. Edit the workflow JSON to tune cadence or filters.',
    configureHint: 'integrations',
  },
  slack: {
    label: 'Slack · waiting on you',
    description:
      'Driven by the slack-inbox-sync workflow — DMs + @mentions waiting on you. Requires a user token (xoxp-*); bot tokens cannot call search.messages.',
    configureHint: 'integrations',
  },
  calendar: {
    label: 'Calendar today',
    description:
      'Driven by the calendar-today-sync workflow — events in the next 12h via osascript, meeting URLs auto-extracted. Requires Calendar automation permission on first run.',
    configureHint: null,
  },
};

/**
 * Inbox IPC: list (cheap, returns cached items) + refresh (re-runs every
 * source). Renderer fetches on tab open + on a manual refresh button.
 * Broadcasts `inbox:changed` whenever items update, `inbox:refreshing`
 * with bool so the spinner can fire from any window.
 *
 * `countInboxSource` + `clearInboxSource` let the Integrations page count
 * + delete the JSON inbox files a removed/disabled MCP populated. The
 * file name is a single segment ("slack-pulse.json"); path validation
 * blocks `..` and absolute paths.
 */
export function registerInboxIpc({
  inbox,
  jarvisRoot,
  activity,
  routines,
  runner,
}: IpcDeps): void {
  ipcMain.handle(IpcChannels.listInbox, () => inbox.list());
  ipcMain.handle(IpcChannels.listInboxDismissed, () => inbox.listDismissed());
  ipcMain.handle(IpcChannels.refreshInbox, () => inbox.refresh());

  /**
   * Hard refresh — re-fires the routines that feed user-authored
   * inbox sources (any enabled routine whose skillId ends with
   * "-inbox") and waits for them before re-reading disk.
   *
   * Why this exists: the regular refresh re-runs the InboxSource
   * fetchers, but for user-authored sources that just means
   * "re-read the JSON file." If the JSON is stale, the inbox is
   * stale too. The "Refresh" button used to feel like a no-op for
   * exactly that reason — you'd click it, the JSON would stay the
   * same on disk, and nothing visible would change.
   *
   * Behavior:
   *   - Fires every enabled `*-inbox` routine in parallel.
   *   - Waits for those tasks to reach a terminal state, or 60s
   *     timeout — whichever first. (Skipped sources keep their
   *     current JSON; better degraded than blocking forever.)
   *   - Calls inbox.refresh() to re-read every source.
   */
  ipcMain.handle(IpcChannels.hardRefreshInbox, async () => {
    const inboxRoutines = routines
      .list()
      .filter(
        (r) =>
          r.enabled !== false &&
          typeof r.skillId === 'string' &&
          r.skillId.endsWith('-inbox'),
      );
    if (inboxRoutines.length === 0) {
      // Nothing user-authored to re-fire; fall back to a soft refresh.
      return inbox.refresh();
    }

    // Fire all of them; collect the task ids the runner spawned so we
    // can wait on them specifically (not on every concurrent task).
    const before = new Set(runner.list().map((t) => t.id));
    for (const r of inboxRoutines) {
      try {
        routines.runNow(r.id);
      } catch (err) {
        console.warn(`hard-refresh: routines.runNow(${r.id}) threw:`, err);
      }
    }
    // Identify the just-launched tasks by diff. runNow() launches
    // synchronously and the task lands in the registry before this
    // line runs.
    const triggered = new Set(
      runner.list().filter((t) => !before.has(t.id)).map((t) => t.id),
    );
    if (triggered.size === 0) {
      // Nothing actually launched (runner missing or all routines
      // refused). Soft refresh and bail.
      return inbox.refresh();
    }

    // Wait for completion or timeout. Listen on the runner's status
    // event for any of our triggered ids transitioning to terminal.
    await new Promise<void>((resolve) => {
      const pending = new Set(triggered);
      const timeout = setTimeout(() => {
        runner.off('status', onStatus);
        resolve();
      }, 60_000);
      const onStatus = (summary: { id: string; status: string }) => {
        if (!pending.has(summary.id)) return;
        if (
          summary.status === 'completed' ||
          summary.status === 'errored' ||
          summary.status === 'aborted'
        ) {
          pending.delete(summary.id);
          if (pending.size === 0) {
            clearTimeout(timeout);
            runner.off('status', onStatus);
            resolve();
          }
        }
      };
      runner.on('status', onStatus);
    });

    return inbox.refresh();
  });
  ipcMain.handle(
    IpcChannels.dismissInboxItem,
    (_e, payload: { id: string; snoozeMs: number }) => {
      // Capture the row before it disappears so the activity log carries
      // a useful label — the dismissed id alone wouldn't tell the user
      // what they snoozed when reading the history later.
      const before = inbox.list().find((it) => it.id === payload.id);
      inbox.dismiss(payload.id, payload.snoozeMs);
      const durMin = Math.round(payload.snoozeMs / 60_000);
      const durLabel =
        durMin < 60
          ? `${durMin}m`
          : durMin < 60 * 24
          ? `${Math.round(durMin / 60)}h`
          : `${Math.round(durMin / (60 * 24))}d`;
      activity.record({
        kind: 'inbox.dismissed',
        label: before
          ? `Inbox dismissed (${durLabel}) · ${before.title}`
          : `Inbox dismissed (${durLabel}) · ${payload.id}`,
        detail: {
          id: payload.id,
          source: before?.source ?? null,
          title: before?.title ?? null,
          snoozeMs: payload.snoozeMs,
        },
      });
    },
  );

  ipcMain.handle(IpcChannels.restoreInboxItem, (_e, id: string) => {
    inbox.restore(id);
    activity.record({
      kind: 'inbox.restored',
      label: `Inbox restored · ${id}`,
      detail: { id },
    });
  });

  const inboxDir = join(jarvisRoot, 'inbox');
  const resolveInboxFile = (name: string): string | null => {
    // Single-segment filename only — block traversal + abs paths.
    if (!name || name.includes('/') || name.includes('..') || name.startsWith('.')) {
      return null;
    }
    const target = normalize(resolve(inboxDir, name));
    if (!target.startsWith(inboxDir)) return null;
    return target;
  };

  ipcMain.handle(
    IpcChannels.countInboxSource,
    (_e, name: string): { count: number; mtimeMs: number | null } => {
      const target = resolveInboxFile(name);
      if (!target || !existsSync(target)) return { count: 0, mtimeMs: null };
      try {
        const raw = readFileSync(target, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        let count = 0;
        if (Array.isArray(parsed)) count = parsed.length;
        else if (
          parsed && typeof parsed === 'object'
          && Array.isArray((parsed as { items?: unknown[] }).items)
        ) {
          count = (parsed as { items: unknown[] }).items.length;
        }
        return { count, mtimeMs: statSync(target).mtimeMs };
      } catch {
        return { count: 0, mtimeMs: null };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.revealInboxFile,
    (_e, name: string): { ok: boolean; message?: string } => {
      const target = resolveInboxFile(name);
      if (!target) return { ok: false, message: 'Invalid inbox file name.' };
      if (!existsSync(target)) {
        return { ok: false, message: 'File not found yet (skill may not have run).' };
      }
      shell.showItemInFolder(target);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.clearInboxSource,
    async (_e, name: string): Promise<{ ok: boolean; message?: string }> => {
      const target = resolveInboxFile(name);
      if (!target) return { ok: false, message: 'Invalid inbox file name.' };
      if (!existsSync(target)) return { ok: true };
      try {
        unlinkSync(target);
        activity.record({
          kind: 'inbox.cleared',
          label: `Inbox source cleared · ${name}`,
          detail: { name, path: target },
        });
        // Force a fresh refresh so the renderer + tray see the items
        // disappear without waiting for the auto-refresh tick.
        await inbox.refresh();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /**
   * Inspector surface for Settings → Inbox. Lists every source the
   * inbox knows about — built-ins (from InboxStore) and user-authored
   * JSON files under ~/.jarvis/inbox/. Augments each with item count,
   * file mtime when applicable, and a heuristic skill match so the
   * UI can offer a "Jump to skill" shortcut.
   */
  ipcMain.handle(
    IpcChannels.listInboxSources,
    (_e, skillIds: string[] = []): InboxSourceSummary[] => {
      const items = inbox.list();
      // Count items per logical source. Items from user files carry
      // their wrapper's source string (e.g. 'slack-pulse'), so this
      // groups them correctly.
      const countBySource = new Map<string, number>();
      for (const item of items) {
        countBySource.set(item.source, (countBySource.get(item.source) ?? 0) + 1);
      }

      const skills = new Set(skillIds);
      const rows: InboxSourceSummary[] = [];

      // Built-ins: emit one row per known meta entry, even when the
      // current count is 0 (the row's existence is its own signal).
      for (const [name, meta] of Object.entries(BUILTIN_SOURCE_META)) {
        rows.push({
          name,
          label: meta.label,
          description: meta.description,
          itemCount: countBySource.get(name) ?? 0,
          kind: 'built-in',
          configureHint: meta.configureHint,
        });
      }

      // User files: enumerate ~/.jarvis/inbox/*.json. File basename is
      // the source id; if a skill exists with the same id, link to it.
      if (existsSync(inboxDir)) {
        let entries: import('node:fs').Dirent[];
        try {
          entries = readdirSync(inboxDir, { withFileTypes: true });
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          if (
            !entry.isFile()
            || !entry.name.endsWith('.json')
            || entry.name.startsWith('.')
          ) continue;
          const base = entry.name.replace(/\.json$/, '');
          const full = join(inboxDir, entry.name);
          let mtimeMs: number | undefined;
          let fileItemCount = 0;
          try {
            mtimeMs = statSync(full).mtimeMs;
            const parsed: unknown = JSON.parse(readFileSync(full, 'utf8'));
            if (Array.isArray(parsed)) fileItemCount = parsed.length;
            else if (
              parsed && typeof parsed === 'object'
              && Array.isArray((parsed as { items?: unknown[] }).items)
            ) {
              fileItemCount = (parsed as { items: unknown[] }).items.length;
            }
          } catch {
            // Bad JSON — show the row so the user can spot the broken
            // file, count stays 0.
          }
          // Prefer the live count from inbox.list() (post snooze/dismiss)
          // when available; fall back to the raw file count.
          const itemCount = countBySource.get(base) ?? fileItemCount;
          const relatedSkillId = skills.has(base) ? base : undefined;
          rows.push({
            name: base,
            label: base,
            description: relatedSkillId
              ? `Written by the ${base} skill. Edit it to change what gets surfaced.`
              : `User-authored inbox file. Anything that writes ${entry.name} feeds this source.`,
            itemCount,
            kind: 'file',
            filePath: full,
            mtimeMs,
            relatedSkillId,
            configureHint: relatedSkillId ? 'skill' : null,
          });
        }
      }
      return rows;
    },
  );
}
