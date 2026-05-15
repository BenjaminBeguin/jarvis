import { useCallback, useEffect, useState } from 'react';

import type { TaskStatus } from '../../shared/types';

/**
 * "This thing I see in the UI has a task running for it." A binding ties
 * an arbitrary string key (inbox item id, note file path, meeting file
 * name, etc.) to a Jarvis Task by id, so the surface can show a status
 * pill + "Open / Run again / Forget" menu instead of letting the user
 * accidentally spawn two tasks for the same row.
 *
 * State lives in localStorage keyed by a namespace per surface
 * ('jarvis.binding.<namespace>'). Status stays live via onTaskStatus.
 */

export interface TaskBindingState {
  taskId: string;
  status: TaskStatus;
  awaitingInput?: boolean;
  /** ms epoch when the binding was created. */
  boundAt: number;
}

export type TaskBindingMap = Record<string, TaskBindingState>;

function storageKey(namespace: string): string {
  return `jarvis.binding.${namespace}`;
}

function load(namespace: string): TaskBindingMap {
  try {
    const raw = window.localStorage.getItem(storageKey(namespace));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function persist(namespace: string, map: TaskBindingMap): void {
  try {
    window.localStorage.setItem(storageKey(namespace), JSON.stringify(map));
  } catch {
    // non-fatal — bindings are cosmetic, not source of truth
  }
}

export interface UseTaskBinding {
  /** Read the current binding for a key, if any. */
  get(key: string): TaskBindingState | undefined;
  /** Record a new binding (overwrites any previous binding for the key). */
  bind(key: string, taskId: string): void;
  /** Drop the binding (user pressed "Forget" or the underlying item is gone). */
  clear(key: string): void;
  /** Drop bindings whose key is not in the live set. Used to clean up
   * orphans on every list refresh. */
  retainKeys(liveKeys: Set<string>): void;
}

export function useTaskBinding(namespace: string): UseTaskBinding {
  const [map, setMap] = useState<TaskBindingMap>(() => load(namespace));

  useEffect(() => {
    persist(namespace, map);
  }, [namespace, map]);

  // Subscribe to live status updates so the badge in the UI reflects
  // running → completed / errored without manual refresh.
  useEffect(() => {
    return window.jarvis.onTaskStatus((summary) => {
      setMap((prev) => {
        let next: TaskBindingMap | null = null;
        for (const [key, b] of Object.entries(prev)) {
          if (b.taskId !== summary.id) continue;
          if (
            b.status === summary.status &&
            (b.awaitingInput ?? false) === (summary.awaitingInput ?? false)
          ) {
            return prev;
          }
          if (!next) next = { ...prev };
          next[key] = {
            ...b,
            status: summary.status,
            awaitingInput: summary.awaitingInput,
          };
        }
        return next ?? prev;
      });
    });
  }, []);

  const get = useCallback((key: string) => map[key], [map]);

  const bind = useCallback((key: string, taskId: string) => {
    setMap((prev) => ({
      ...prev,
      [key]: {
        taskId,
        boundAt: Date.now(),
        // Optimistic — onTaskStatus will correct this within a tick.
        status: 'running',
      },
    }));
  }, []);

  const clear = useCallback((key: string) => {
    setMap((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const retainKeys = useCallback((liveKeys: Set<string>) => {
    setMap((prev) => {
      let next: TaskBindingMap | null = null;
      for (const key of Object.keys(prev)) {
        if (!liveKeys.has(key)) {
          if (!next) next = { ...prev };
          delete next[key];
        }
      }
      return next ?? prev;
    });
  }, []);

  return { get, bind, clear, retainKeys };
}
