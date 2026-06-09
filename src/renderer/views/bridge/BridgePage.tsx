import { useCallback, useEffect, useState } from 'react';

import type { InboxItem } from '../../../shared/types';


import { CommandRail } from './CommandRail';
import { FocusCard } from './FocusCard';
import { ProjectPulse } from './ProjectPulse';
import { StreamTicker } from './StreamTicker';
import { SystemStatus } from './SystemStatus';
import { TodayTimeline } from './TodayTimeline';
import './bridge.css';

/**
 * BridgePage — the new "command bridge" home view.
 *
 * Three zones stacked vertically:
 *
 *   1. **Focus** (hero) — single hero card. The ONE thing that
 *      matters now. Big title, one CTA, optional secondary.
 *   2. **Pulse** (per-project vitals) — one card per project with
 *      live counts of PRs / awaiting threads / today's meetings /
 *      drafts / live tasks. Click a card to switch project scope.
 *   3. **Stream** (ambient) — horizontal ticker of background
 *      activity (workflows, drafts, browser visits, notifications).
 *      Disney-queue effect: always in motion at a slow ambient pace.
 *
 * The aesthetic borrows from the Iron-Man / Stark-HUD vocabulary:
 * bracket markers around live values, alignment notches between
 * zones, scanline pulse on active elements. The visual library
 * already exists in the codebase (Orb, Constellation, MemoryGraph) —
 * we compose it here behind a unified frame.
 *
 * Replaces the old Dashboard as the Working-mode landing tab. The
 * Dashboard is still reachable from the building-mode sidebar for
 * configuration (skill grid, cost panel, briefings) — those will
 * later migrate behind drilldowns from Bridge cards too.
 */
export function BridgePage() {
  const [activeProject, setActiveProject] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem('jarvis.activeProject') || null;
    } catch {
      return null;
    }
  });

  // Sync with the shell scope picker — listening on the existing
  // jarvis:active-project-changed CustomEvent that the shell broadcasts.
  useEffect(() => {
    const onScope = (e: Event) => {
      const detail = (e as CustomEvent).detail as { project?: string | null };
      setActiveProject(detail?.project ?? null);
    };
    window.addEventListener('jarvis:active-project-changed', onScope);
    return () =>
      window.removeEventListener('jarvis:active-project-changed', onScope);
  }, []);

  // Force an inbox refresh on Bridge mount so we never show "all clear"
  // just because the renderer landed here before the 5-min auto-refresh
  // cron fired. Same pattern the Inbox view uses. Fire-and-forget;
  // the children subscribe to onInboxChanged so they'll catch the
  // resulting broadcast.
  useEffect(() => {
    void window.jarvis.refreshInbox().catch(() => {
      // Refresh failures aren't fatal — the children still show
      // whatever's already in the store.
    });
  }, []);

  /** Click on a Pulse card → fire the same event the Shell uses to
   *  swap project scope. Keeps the picker, ambient context, eager-RAG
   *  scoping, and the inbox filter all in lockstep. */
  const selectProject = useCallback((name: string) => {
    const next = activeProject === name ? null : name;
    try {
      if (next) window.localStorage.setItem('jarvis.activeProject', next);
      else window.localStorage.removeItem('jarvis.activeProject');
    } catch {
      // ignore
    }
    setActiveProject(next);
    window.dispatchEvent(
      new CustomEvent('jarvis:active-project-changed', {
        detail: { project: next },
      }),
    );
  }, [activeProject]);

  /**
   * Live agent sessions keyed by the InboxItem id that launched
   * them. When the user clicks a `task`-action row, routePrompt
   * returns the new task summary; we stash its id here so FocusCard
   * can render an inline RowSession (status + tail + cancel) right
   * under the row instead of the user having to jump to the AI
   * Agent tab to see what's happening.
   */
  const [activeSessions, setActiveSessions] = useState<
    Record<string, string>
  >({});
  const cancelSession = useCallback((taskId: string) => {
    void window.jarvis.abortTask(taskId);
  }, []);
  const openFullSession = useCallback((taskId: string) => {
    // Same event the Activity tab uses to surface a task in the
    // SessionSidebar / Observatory.
    window.dispatchEvent(
      new CustomEvent('jarvis:open-session', { detail: { taskId } }),
    );
  }, []);

  /** Click on the Focus CTA. Routes based on the item's action shape:
   *   - action.kind === 'open-url' → open URL externally
   *   - action.kind === 'task' (or missing) → dispatch the prompt
   *     AND attach the resulting task id to this row so the inline
   *     RowSession panel can render live progress
   *   - calendar item with url → open meeting
   *   - reminder / work-awareness (no action / no url) → dismiss the
   *     inbox item in place; the row disappears, user stays on Bridge
   *   - fallback → jump to Inbox so user can act manually
   *
   * The "dismiss in place" path is the right move for commitment-style
   * items where the user just wants to say "I handled that, move on" —
   * navigating to another page would yank them out of context.
   */
  const onAct = useCallback(async (item: InboxItem) => {
    if (item.action?.kind === 'open-url') {
      const url = item.action.url ?? item.url;
      if (url) void window.jarvis.openExternal(url);
      return;
    }
    if (item.action?.kind === 'task' || (item.action && !item.action.kind)) {
      const prompt = item.action.prompt ?? item.title;
      try {
        const result = await window.jarvis.routePrompt(prompt, {
          origin: 'palette',
        });
        if (result?.kind === 'task' && result.task?.id) {
          setActiveSessions((prev) => ({ ...prev, [item.id]: result.task.id }));
        }
      } catch (err) {
        console.warn('[bridge] routePrompt failed:', err);
      }
      return;
    }
    if (item.source === 'calendar' && item.url) {
      void window.jarvis.openExternal(item.url);
      return;
    }
    // Acknowledgement-style sources without an explicit action: clicking
    // ✓ ADDRESSED / ✓ DONE should just remove the row. Forever-dismiss
    // (huge snoozeMs sentinel — same value the Inbox view uses for its
    // "Dismiss forever" menu item) so the broadcasted inbox-changed
    // refresh drops it from the Bridge in place.
    if (
      !item.action &&
      !item.url &&
      (item.source === 'work-awareness' || item.source === 'reminders')
    ) {
      const FOREVER_MS = 4_102_444_800_000; // ~year 2100
      void window.jarvis.dismissInboxItem(item.id, FOREVER_MS);
      return;
    }
    if (item.url) {
      void window.jarvis.openExternal(item.url);
      return;
    }
    // Truly nothing actionable — last-resort fallback. Anything that
    // hits this is a data gap on the source side (item with no url,
    // no action, unrecognised acknowledge-source).
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
    );
  }, []);

  return (
    <section className="bridge">
      <div className="bridge__hud-frame">
        <span className="bridge__notch bridge__notch--tl" aria-hidden />
        <span className="bridge__notch bridge__notch--tr" aria-hidden />
        <span className="bridge__notch bridge__notch--bl" aria-hidden />
        <span className="bridge__notch bridge__notch--br" aria-hidden />
        <div className="bridge__scanline" aria-hidden />

        <header className="bridge__header">
          <div className="bridge__header-left">
            <h1 className="bridge__title">BRIDGE</h1>
            <span className="bridge__sub">
              {activeProject
                ? `scope · ${activeProject}`
                : 'scope · all projects'}
            </span>
          </div>
          <SystemStatus />
        </header>

        <div className="bridge__rail-zone">
          <CommandRail />
        </div>

        <div className="bridge__focus-zone">
          <FocusCard
            onAct={onAct}
            activeProject={activeProject}
            activeSessions={activeSessions}
            onCancelSession={cancelSession}
            onOpenSession={openFullSession}
          />
        </div>

        <div className="bridge__today-zone">
          <TodayTimeline />
        </div>

        <div className="bridge__pulse-zone">
          <ProjectPulse
            activeProject={activeProject}
            onSelectProject={selectProject}
          />
        </div>

        <div className="bridge__stream-zone">
          <StreamTicker />
        </div>
      </div>
    </section>
  );
}
