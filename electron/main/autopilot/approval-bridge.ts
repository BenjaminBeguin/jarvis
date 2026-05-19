import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { IpcChannels } from '@shared/ipc';

import { broadcast } from '../windows.js';

/**
 * Main-process broker for the `prompt-output` workflow node. When a
 * node calls `await()`, the bridge broadcasts an `approvalRequested`
 * event to the renderer (Shell.tsx subscribes and pops a modal) and
 * returns a Promise that the renderer settles via the `approve` /
 * `reject` IPC channels.
 *
 * One Promise pending at a time isn't required — each request is
 * keyed by a `requestId`, so multiple workflows could open prompts
 * simultaneously. The renderer queues them and presents one at a
 * time, but the bridge doesn't enforce that.
 */

export interface ApprovalPayload {
  /** Heading for the modal — "Autopilot · Slack DM acknowledgment". */
  title: string;
  /** One-liner under the title. Optional context. */
  summary?: string;
  /** Full content the agent produced. Editable in the HUD before
   *  Accept. Edits become the "feedback" the user implicitly gave. */
  body?: string;
  /** Read-only context the user sees alongside the draft (e.g. the
   *  Slack thread, the PR diff, the inbox row). Markdown OK. */
  context?: string;
  /** Origin workflow id — used for the feedback file path. */
  workflowId: string;
}

export interface ApprovalRequested extends ApprovalPayload {
  requestId: string;
}

export type ApprovalDecision =
  | { decision: 'accept'; editedBody?: string }
  | { decision: 'reject'; feedback?: string };

interface Pending {
  resolve: (d: ApprovalDecision) => void;
  payload: ApprovalPayload;
}

export class ApprovalBridge extends EventEmitter {
  private pending = new Map<string, Pending>();

  /**
   * Block until the user settles the prompt. Broadcasts an
   * `approvalRequested` event with a freshly-minted requestId; the
   * returned promise resolves when the renderer calls back via
   * `settle()`. Pending forever — the workflow can be aborted via
   * the run's normal abort path if the user never answers.
   */
  await(payload: ApprovalPayload): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve, payload });
      const event: ApprovalRequested = { ...payload, requestId };
      broadcast(IpcChannels.autopilotApprovalRequested, event);
      this.emit('requested', event);
    });
  }

  /** Renderer calls this via IPC. Resolves the pending Promise and
   *  drops the entry. No-op if requestId isn't known (caller refreshed
   *  the window or the workflow was already aborted). */
  settle(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /** Abort all pending — used on app shutdown or a hard scheduler
   *  restart. Each pending Promise resolves to a synthetic reject. */
  closeAll(reason = 'cancelled'): void {
    for (const [, p] of this.pending) {
      p.resolve({ decision: 'reject', feedback: reason });
    }
    this.pending.clear();
  }
}

/** Singleton — wired in main process index.ts. */
export const approvalBridge = new ApprovalBridge();
