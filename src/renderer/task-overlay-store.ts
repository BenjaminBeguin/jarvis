import { useEffect, useState } from 'react';

import { conversationStore } from './conversation/conversation-store';

/**
 * **Legacy shim.** This file used to drive a centered task-overlay
 * modal mounted in Shell; the unified conversation sidebar has
 * replaced that surface. `openTaskOverlay(id)` now pushes the task
 * into the conversation-store (sidebar slide-in). `useTaskOverlayId`
 * still exists but always returns `null` — any remaining renderers
 * that conditionally mount TaskOverlay will simply render nothing.
 *
 * Callers can migrate to `conversationStore.open({...})` directly
 * for richer payloads (title + origin); the shim is here so the
 * sweeping refactor doesn't require touching every call site at once.
 */

type Listener = (id: string | null) => void;

const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(null);
}

export async function openTaskOverlay(id: string): Promise<void> {
  if (!id) return;
  // Resolve the task to give the sidebar a useful tab title. Fail
  // open with the bare id if listTasks errors / the task isn't found
  // (still pushes to the store so the surface appears).
  let title = id;
  try {
    const tasks = await window.jarvis.listTasks();
    const task = tasks.find((t) => t.id === id);
    if (task) {
      title =
        task.title ||
        task.inputPreview?.slice(0, 60) ||
        task.skillId ||
        task.id;
    }
  } catch {
    // ignore — title falls back to id
  }
  conversationStore.open({
    taskId: id,
    title,
    origin: 'user-click',
  });
  emit();
}

export function closeTaskOverlay(): void {
  emit();
}

export function getOpenTaskOverlayId(): string | null {
  return null;
}

export function useTaskOverlayId(): string | null {
  const [val, setVal] = useState<string | null>(null);
  useEffect(() => {
    listeners.add(setVal);
    return () => {
      listeners.delete(setVal);
    };
  }, []);
  return val;
}
