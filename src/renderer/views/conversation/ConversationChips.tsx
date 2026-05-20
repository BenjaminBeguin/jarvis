import { useEffect } from 'react';

import {
  conversationStore,
  useConversationStore,
} from '../../conversation/conversation-store';

/**
 * Bottom-right strip of reduced conversations. Each chip carries
 * the conversation's title + a status dot; clicking re-expands it
 * into the sidebar via conversationStore.bump(). The × dismisses
 * the conversation entirely (the task keeps running in the
 * background but stops surfacing in this UI).
 *
 * Side effect: pushes the chip count to the tray tooltip so the user
 * sees "💬 N reduced" when Jarvis isn't focused.
 */

export function ConversationChips() {
  const state = useConversationStore();

  // Mirror the count to the tray.
  useEffect(() => {
    void window.jarvis.setReducedConversationsCount(state.reduced.length);
  }, [state.reduced.length]);

  if (state.reduced.length === 0) return null;
  return (
    <div className="convo-chips" role="region" aria-label="Reduced conversations">
      {state.reduced.map((entry) => (
        <div
          key={entry.taskId}
          className={`convo-chip convo-chip--${entry.status}`}
          role="button"
          tabIndex={0}
          onClick={() => conversationStore.bump(entry.taskId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              conversationStore.bump(entry.taskId);
            }
          }}
          title={entry.title}
        >
          <span
            className={`convo-chip__status convo-chip__status--${entry.status}`}
            aria-hidden
          />
          <span className="convo-chip__title">{entry.title}</span>
          <button
            type="button"
            className="convo-chip__dismiss"
            onClick={(e) => {
              e.stopPropagation();
              conversationStore.dismiss(entry.taskId);
            }}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
