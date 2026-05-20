import { useSyncExternalStore } from 'react';

import type { TaskSummary } from '../../shared/types';
import type { ConvoEntry, ConversationOrigin } from './types';

/**
 * Renderer-side state for the unified conversation surface. Single
 * source of truth for which conversations are open in the sidebar
 * vs reduced into the chip strip + their pinned/active status.
 *
 * No new dependency — the store is a tiny custom one that exposes
 * `subscribe` + `getSnapshot`, consumed via React's built-in
 * `useSyncExternalStore`. State is in-process renderer memory; not
 * persisted across restart (the SQLite-backed task history survives,
 * but the chip/sidebar list is ephemeral).
 *
 * Trigger flow:
 *
 *   palette / inbox / workflow run-now → conversationStore.open(req)
 *     → entry lands in `open[]` with `active: true`, sidebar pops
 *
 *   autopilot tick / scheduled-action fire → conversationStore.open(req)
 *     → entry lands in `reduced[]` (origin gates the placement) so
 *       it doesn't yank focus; chip + tray badge surface it
 *
 *   User clicks Reduce on a sidebar tab → moves to reduced[]
 *   User clicks the chip → moves back to open[]
 *   User dismisses → removed entirely (task keeps running in main)
 *   Task transitions to errored → auto-bumps from reduced to open
 */

interface State {
  open: ConvoEntry[];
  reduced: ConvoEntry[];
  /** Which open tab is foregrounded in the sidebar. */
  activeTaskId: string | null;
  /** Whether the sidebar slide-in is visible at all (false when no
   *  conversations open + the user hasn't pinned the panel). */
  sidebarVisible: boolean;
}

export interface OpenRequest {
  taskId: string;
  title: string;
  origin: ConversationOrigin;
  startedAt?: number;
  /** Force the entry to land in `reduced[]` rather than `open[]`,
   *  regardless of origin defaults. */
  startReduced?: boolean;
}

type Listener = () => void;

let state: State = {
  open: [],
  reduced: [],
  activeTaskId: null,
  sidebarVisible: false,
};

const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(next: State): void {
  state = next;
  emit();
}

/** Which origins land as chips by default. */
function defaultsToReduced(origin: ConversationOrigin): boolean {
  return origin === 'autopilot' || origin === 'scheduled-action';
}

export const conversationStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): State {
    return state;
  },

  /**
   * Push a conversation. If an entry with the same taskId already
   * exists in `open` or `reduced`, this is a no-op — the chip /
   * tab is reused, not duplicated.
   */
  open(req: OpenRequest): void {
    const existsOpen = state.open.find((e) => e.taskId === req.taskId);
    const existsReduced = state.reduced.find((e) => e.taskId === req.taskId);
    if (existsOpen) {
      setState({
        ...state,
        activeTaskId: req.taskId,
        sidebarVisible: true,
      });
      return;
    }
    if (existsReduced) {
      // Bump from chip to sidebar tab.
      setState({
        ...state,
        open: [...state.open, { ...existsReduced, active: true }],
        reduced: state.reduced.filter((e) => e.taskId !== req.taskId),
        activeTaskId: req.taskId,
        sidebarVisible: true,
      });
      return;
    }
    const reduced = req.startReduced ?? defaultsToReduced(req.origin);
    const entry: ConvoEntry = {
      taskId: req.taskId,
      title: req.title,
      origin: req.origin,
      startedAt: req.startedAt ?? Date.now(),
      status: 'running',
      active: !reduced,
      pinned: false,
    };
    if (reduced) {
      setState({
        ...state,
        reduced: [...state.reduced, entry],
      });
    } else {
      setState({
        ...state,
        open: [...state.open, entry],
        activeTaskId: req.taskId,
        sidebarVisible: true,
      });
    }
  },

  /** Move a sidebar tab to the reduced chip strip. */
  reduce(taskId: string): void {
    const tab = state.open.find((e) => e.taskId === taskId);
    if (!tab) return;
    const nextOpen = state.open.filter((e) => e.taskId !== taskId);
    setState({
      ...state,
      open: nextOpen,
      reduced: [...state.reduced, { ...tab, active: false }],
      activeTaskId:
        state.activeTaskId === taskId
          ? (nextOpen[0]?.taskId ?? null)
          : state.activeTaskId,
      sidebarVisible: nextOpen.length > 0,
    });
  },

  /** Re-expand a chip into a sidebar tab. */
  bump(taskId: string): void {
    const chip = state.reduced.find((e) => e.taskId === taskId);
    if (!chip) return;
    setState({
      ...state,
      open: [...state.open, { ...chip, active: true }],
      reduced: state.reduced.filter((e) => e.taskId !== taskId),
      activeTaskId: taskId,
      sidebarVisible: true,
    });
  },

  /** Dismiss a conversation entirely (from either bucket). The
   *  underlying task keeps running — this only stops surfacing it. */
  dismiss(taskId: string): void {
    const nextOpen = state.open.filter((e) => e.taskId !== taskId);
    const nextReduced = state.reduced.filter((e) => e.taskId !== taskId);
    setState({
      ...state,
      open: nextOpen,
      reduced: nextReduced,
      activeTaskId:
        state.activeTaskId === taskId
          ? (nextOpen[0]?.taskId ?? null)
          : state.activeTaskId,
      sidebarVisible: nextOpen.length > 0,
    });
  },

  /** Set which open tab is foregrounded. */
  focus(taskId: string): void {
    if (!state.open.some((e) => e.taskId === taskId)) return;
    setState({ ...state, activeTaskId: taskId, sidebarVisible: true });
  },

  /** Toggle a tab's pinned flag. */
  pin(taskId: string, value?: boolean): void {
    const apply = (e: ConvoEntry): ConvoEntry =>
      e.taskId === taskId ? { ...e, pinned: value ?? !e.pinned } : e;
    setState({
      ...state,
      open: state.open.map(apply),
      reduced: state.reduced.map(apply),
    });
  },

  /** Hide the sidebar without dismissing anything. Tabs (pinned or
   *  not) survive — they're just hidden until the user re-opens the
   *  sidebar via a chip, ⌘\\, or a new launch. Pin only matters for
   *  future auto-hide paths (tab navigation, click-outside); a
   *  user-initiated close always wins. */
  hideSidebar(): void {
    setState({ ...state, sidebarVisible: false });
  },

  /** Show / focus the sidebar; if there's no active tab pick the
   *  most-recently-opened one. */
  showSidebar(): void {
    if (state.sidebarVisible) return;
    setState({
      ...state,
      sidebarVisible: true,
      activeTaskId:
        state.activeTaskId ?? state.open[state.open.length - 1]?.taskId ?? null,
    });
  },

  /**
   * Apply a TaskSummary update (status / endedAt) to whichever
   * bucket holds it. Errored tasks auto-bump from reduced to open.
   */
  applyStatus(summary: TaskSummary): void {
    const id = summary.id;
    const errored = summary.status === 'errored';
    const update = (e: ConvoEntry): ConvoEntry =>
      e.taskId === id ? { ...e, status: summary.status } : e;
    let nextOpen = state.open.map(update);
    let nextReduced = state.reduced.map(update);
    let activeTaskId = state.activeTaskId;
    let sidebarVisible = state.sidebarVisible;
    if (errored) {
      const chip = nextReduced.find((e) => e.taskId === id);
      if (chip) {
        nextOpen = [...nextOpen, { ...chip, active: true }];
        nextReduced = nextReduced.filter((e) => e.taskId !== id);
        activeTaskId = id;
        sidebarVisible = true;
      }
    }
    setState({
      open: nextOpen,
      reduced: nextReduced,
      activeTaskId,
      sidebarVisible,
    });
  },

  /** Remove a task that was deleted from the runner. */
  removeRunnerTask(taskId: string): void {
    this.dismiss(taskId);
  },
};

/** Hook wrapper. Returns the full state; components select what they
 *  care about. The state object is replaced wholesale on any change
 *  so reference equality works as the bail-out. */
export function useConversationStore(): State {
  return useSyncExternalStore(
    conversationStore.subscribe,
    conversationStore.getSnapshot,
    conversationStore.getSnapshot,
  );
}
