import { useEffect, useRef, useState } from 'react';

import type { TaskBindingState } from './useTaskBinding';

interface Props {
  binding: TaskBindingState;
  /** Open the existing task (HUD or Observatory — caller decides). */
  onOpen: () => void;
  /** Re-fire the action as a fresh task. The caller is expected to
   * trigger the same launch flow that produced the original binding. */
  onRunAgain: () => void;
  /** Drop the binding without re-firing. Useful if the user no longer
   * cares about the existing task and wants a clean slate. */
  onForget: () => void;
  /** Re-fire labels vary by surface. Default: "Run again in new session". */
  runAgainLabel?: string;
}

/**
 * The single status-pill-with-menu the app uses everywhere an item is
 * bound to a running task. Replaces the naked launch button across
 * Inbox / Notes / Meetings so the user never accidentally fires two
 * tasks for the same thing.
 *
 * One click opens the task (most common intent). The ⋯ menu exposes
 * "Run again in new session" (explicit, opt-in re-fire) + "Forget
 * binding" (lose the link without spawning).
 */
export function TaskBindingBadge({
  binding,
  onOpen,
  onRunAgain,
  onForget,
  runAgainLabel = 'Run again in new session',
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click — small but important for a menu
  // that lives inside a list row.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const running = binding.status === 'running' || binding.status === 'queued';
  const awaiting = binding.awaitingInput === true;
  const label = awaiting
    ? '⏸ Awaiting reply'
    : running
      ? '⟳ Running…'
      : binding.status === 'completed'
        ? '✓ Done'
        : binding.status === 'errored'
          ? '⚠ Failed'
          : binding.status === 'aborted'
            ? '— Aborted'
            : binding.status;

  return (
    <div
      ref={wrapperRef}
      className={`task-binding task-binding--${running ? 'running' : binding.status}${
        awaiting ? ' task-binding--awaiting' : ''
      }`}
    >
      <button
        className="task-binding__main"
        onClick={onOpen}
        title={`Task ${binding.taskId} · click to open`}
      >
        {label}
      </button>
      <button
        className="task-binding__menu-toggle"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="More options"
        title="More options"
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="task-binding__menu">
          <button
            onClick={() => {
              setMenuOpen(false);
              // Open the in-window Session Sidebar (mounted at Shell
              // level). This preserves the user's current tab + scroll
              // — distinct from the main pill click which routes to
              // the consumer's onOpen (typically the Answer HUD window).
              window.dispatchEvent(
                new CustomEvent('jarvis:open-session', {
                  detail: { taskId: binding.taskId },
                }),
              );
            }}
            title="Peek at the session here without leaving this view"
          >
            Open Claude session
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              onRunAgain();
            }}
          >
            {runAgainLabel}
          </button>
          <button
            className="task-binding__menu-forget"
            onClick={() => {
              setMenuOpen(false);
              onForget();
            }}
          >
            Forget binding
          </button>
        </div>
      )}
    </div>
  );
}
