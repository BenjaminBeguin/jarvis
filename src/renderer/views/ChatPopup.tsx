import { useMemo } from 'react';

import { Conversation } from './conversation/Conversation';

/**
 * Standalone floating window that renders one <Conversation>.
 * Opened from the tray menu when the user clicks a pinned
 * conversation while the main app isn't focused — so they can
 * keep reading / replying without us yanking focus out of
 * whatever they were doing.
 *
 * Reads `taskId` from the URL hash (`#/chat-popup?taskId=…`)
 * and just delegates the rest to the unified Conversation
 * component.
 */

function getTaskIdFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get('taskId');
}

export function ChatPopup() {
  const taskId = useMemo(() => getTaskIdFromHash(), []);

  if (!taskId) {
    return (
      <div className="chat-popup chat-popup--empty">
        No task id provided.
      </div>
    );
  }

  return (
    <div className="chat-popup">
      <Conversation taskId={taskId} mode="cozy" />
    </div>
  );
}
