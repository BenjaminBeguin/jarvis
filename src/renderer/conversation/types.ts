import type { TaskSummary } from '../../shared/types';

/**
 * Where an open conversation came from. Drives default state
 * (auto-triggered ones land as chips so they don't yank focus;
 * user-clicks pop the sidebar tab open immediately).
 */
export type ConversationOrigin =
  | 'user-click'
  | 'autopilot'
  | 'scheduled-action'
  | 'workflow'
  | 'external';

/** One conversation tracked by the conversation-store. Drives both
 *  the sidebar tab and the reduced chip. */
export interface ConvoEntry {
  taskId: string;
  title: string;
  origin: ConversationOrigin;
  startedAt: number;
  status: TaskSummary['status'];
  /** True when this conversation is in the sidebar (vs chip strip). */
  active: boolean;
  /** Keep this tab open across navigation when set. */
  pinned: boolean;
}

/** Visual rendering mode for the <Conversation> component.
 *  - `cozy` (default): chat bubbles, tools as collapsed one-liners,
 *    thinking as a 1-line summary. Default for the sidebar.
 *  - `full`: every event visible, JSON-expandable, system events
 *    togglable. The Observatory panel uses this. */
export type ConversationMode = 'cozy' | 'full';

/**
 * One renderable item in the chat timeline. Tool calls absorb their
 * matching tool_result so we can render the pair as a single
 * collapsible row instead of two unrelated blocks.
 */
export interface ChatItemImage {
  /** `data:image/png;base64,…` so the renderer can drop it
   *  straight into <img src>. */
  dataUrl: string;
}

export type ChatItem =
  | { kind: 'assistant'; key: string; ts: number; text: string }
  | {
      kind: 'user';
      key: string;
      ts: number;
      text: string;
      images?: ChatItemImage[];
    }
  | {
      kind: 'tool';
      key: string;
      ts: number;
      name: string;
      input: unknown;
      /** Preview line shown on the collapsed row (first identifying arg). */
      preview: string | null;
      result: string | null;
      isError: boolean;
    }
  | {
      kind: 'thinking';
      key: string;
      ts: number;
      /** The full system-event JSON, shown when the user expands. */
      body: string;
      subtype: string;
    }
  | {
      kind: 'result';
      key: string;
      ts: number;
      durationMs: number;
      costUsd: number;
    }
  | {
      kind: 'error';
      key: string;
      ts: number;
      body: string;
      aborted: boolean;
    };
