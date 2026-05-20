import { useEffect } from 'react';

import {
  conversationStore,
  useConversationStore,
} from '../../conversation/conversation-store';
import { Conversation } from './Conversation';

/**
 * Right-rail slide-in panel that hosts every active conversation.
 * Tab strip across the top — one tab per open ConvoEntry. Active
 * tab's transcript renders below in <Conversation mode="cozy">.
 *
 * Triggers that pop the sidebar:
 *   - conversationStore.open() from any palette / Inbox / workflow
 *     dispatch
 *   - jarvis:open-session DOM event (back-compat with SessionSidebar
 *     callers — they pass a taskId and we open it)
 *   - ⌘\ hotkey → open most-recent running task
 *
 * Esc collapses the sidebar (pinned tabs survive — they stay
 * visible). Clicking outside dismisses too. Close button on each
 * tab reduces THAT tab to the chip strip; the X on the panel
 * collapses the whole panel (chips remain).
 */

export function ConversationSidebar() {
  const state = useConversationStore();

  // Back-compat: anywhere in the app can dispatch
  // jarvis:open-session with a taskId to peek at a session.
  useEffect(() => {
    const onOpen = async (e: Event): Promise<void> => {
      const detail = (e as CustomEvent).detail as
        | { taskId?: string; title?: string }
        | undefined;
      if (!detail || typeof detail.taskId !== 'string') return;
      // Resolve task to learn its title if the caller didn't supply.
      let title = detail.title;
      if (!title) {
        try {
          const tasks = await window.jarvis.listTasks();
          const task = tasks.find((t) => t.id === detail.taskId);
          title = task?.title || task?.inputPreview?.slice(0, 60) || task?.skillId || detail.taskId;
        } catch {
          title = detail.taskId;
        }
      }
      conversationStore.open({
        taskId: detail.taskId,
        title: title ?? detail.taskId,
        origin: 'user-click',
      });
    };
    window.addEventListener('jarvis:open-session', onOpen);
    return () => window.removeEventListener('jarvis:open-session', onOpen);
  }, []);

  // ⌘\ — peek at the most-recent running task. Skipped when focus
  // is in a text field so typing `\` in markdown still works.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent): Promise<void> => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== '\\') return;
      const inField =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;
      if (inField) return;
      e.preventDefault();
      const tasks = await window.jarvis.listTasks();
      const ours = tasks.filter((t) => t.origin !== 'external');
      const sorted = [...ours].sort((a, b) => b.startedAt - a.startedAt);
      const running = sorted.find((t) => t.status === 'running');
      const target = running ?? sorted[0];
      if (!target) return;
      conversationStore.open({
        taskId: target.id,
        title: target.title || target.inputPreview?.slice(0, 60) || target.skillId || target.id,
        origin: 'user-click',
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Esc → close the sidebar (pinned tabs keep it open).
  useEffect(() => {
    if (!state.sidebarVisible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') conversationStore.hideSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.sidebarVisible]);

  // Subscribe to taskStatus / taskRemoved → keep ConvoEntry state in sync.
  useEffect(() => {
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      conversationStore.applyStatus(summary);
    });
    const offRemoved = window.jarvis.onTaskRemoved((id) => {
      conversationStore.removeRunnerTask(id);
    });
    return () => {
      offStatus();
      offRemoved();
    };
  }, []);

  if (!state.sidebarVisible) return null;

  const active = state.open.find((e) => e.taskId === state.activeTaskId)
    ?? state.open[0]
    ?? null;

  return (
    <div className="convo-sidebar-host" aria-hidden={!state.sidebarVisible}>
      <div
        className="convo-sidebar-backdrop"
        onClick={() => conversationStore.hideSidebar()}
        aria-label="Close conversation panel"
      />
      <aside
        className="convo-sidebar"
        role="dialog"
        aria-label="Conversations"
      >
        <header className="convo-sidebar__head">
          <div className="convo-sidebar__tabs" role="tablist">
            {state.open.map((entry) => {
              const isActive = entry.taskId === state.activeTaskId;
              return (
                <button
                  key={entry.taskId}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`convo-sidebar__tab${isActive ? ' convo-sidebar__tab--active' : ''}${entry.pinned ? ' convo-sidebar__tab--pinned' : ''}`}
                  onClick={() => conversationStore.focus(entry.taskId)}
                  title={entry.title}
                >
                  <span
                    className={`convo-sidebar__tab-status convo-sidebar__tab-status--${entry.status}`}
                    aria-hidden
                  />
                  <span className="convo-sidebar__tab-title">{entry.title}</span>
                  <span
                    role="button"
                    aria-label="Reduce to chip"
                    className="convo-sidebar__tab-reduce"
                    onClick={(e) => {
                      e.stopPropagation();
                      conversationStore.reduce(entry.taskId);
                    }}
                    title="Reduce to chip"
                  >
                    –
                  </span>
                </button>
              );
            })}
          </div>
          <div className="convo-sidebar__head-actions">
            {active && (
              <button
                type="button"
                className={`convo-sidebar__pin${active.pinned ? ' convo-sidebar__pin--on' : ''}`}
                onClick={() => conversationStore.pin(active.taskId)}
                title={active.pinned ? 'Unpin tab' : 'Pin tab open'}
                aria-pressed={active.pinned}
              >
                {active.pinned ? '📌' : '📍'}
              </button>
            )}
            <button
              type="button"
              className="convo-sidebar__close"
              onClick={() => conversationStore.hideSidebar()}
              aria-label="Hide sidebar (Esc)"
              title="Hide sidebar (Esc)"
            >
              ×
            </button>
          </div>
        </header>
        <div className="convo-sidebar__body">
          {active ? (
            <Conversation key={active.taskId} taskId={active.taskId} mode="cozy" />
          ) : (
            <div className="convo-sidebar__empty">No conversation selected.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
