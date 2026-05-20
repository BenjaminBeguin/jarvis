import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { BatchDecision } from '@shared/types';

import { approvalBridge } from '../autopilot/approval-bridge.js';
import {
  clearFeedback,
  listFeedback,
  readFeedback,
} from '../autopilot/feedback-store.js';
import type { ActivityStore } from '../activity-store.js';

/**
 * Renderer ↔ main wiring for the autopilot approval flow + the
 * Settings panel's feedback trail viewer.
 *
 * Approve:   payload { requestId, editedBody? } → bridge.settle accept
 * Reject:    payload { requestId, feedback? }   → bridge.settle reject
 *
 * Both record an activity entry so the user has a permanent log
 * even after the toast fades.
 */
interface AutopilotIpcDeps {
  activity: ActivityStore;
}

export function registerAutopilotIpc(deps: AutopilotIpcDeps): void {
  ipcMain.handle(
    IpcChannels.autopilotApprove,
    (
      _e,
      payload: { requestId: string; editedBody?: string },
    ): { ok: boolean } => {
      if (!payload?.requestId) return { ok: false };
      const ok = approvalBridge.settle(payload.requestId, {
        decision: 'accept',
        editedBody: payload.editedBody,
      });
      if (ok) {
        deps.activity.record({
          kind: 'autopilot.approved',
          label: 'Autopilot approval · accepted',
          detail: {
            requestId: payload.requestId,
            edited: !!payload.editedBody,
          },
        });
      }
      return { ok };
    },
  );

  ipcMain.handle(
    IpcChannels.autopilotReject,
    (
      _e,
      payload: { requestId: string; feedback?: string },
    ): { ok: boolean } => {
      if (!payload?.requestId) return { ok: false };
      const ok = approvalBridge.settle(payload.requestId, {
        decision: 'reject',
        feedback: payload.feedback,
      });
      if (ok) {
        deps.activity.record({
          kind: 'autopilot.rejected',
          label: 'Autopilot approval · rejected',
          detail: {
            requestId: payload.requestId,
            hasFeedback: !!payload.feedback,
          },
        });
      }
      return { ok };
    },
  );

  // Batch settle. Renderer sends one IPC at the end of the HUD
  // session (all rows decided or user clicked Done) carrying every
  // per-row decision. Activity feed gets one summary row per batch
  // — too noisy to log every individual row.
  ipcMain.handle(
    IpcChannels.autopilotApproveBatch,
    (
      _e,
      payload: { requestId: string; decisions: BatchDecision[] },
    ): { ok: boolean } => {
      if (!payload?.requestId || !Array.isArray(payload.decisions)) {
        return { ok: false };
      }
      const ok = approvalBridge.settleBatch(
        payload.requestId,
        payload.decisions,
      );
      if (ok) {
        const accepted = payload.decisions.filter(
          (d) => d.decision === 'accept',
        ).length;
        const rejected = payload.decisions.filter(
          (d) => d.decision === 'reject',
        ).length;
        const skipped = payload.decisions.filter(
          (d) => d.decision === 'skip',
        ).length;
        deps.activity.record({
          kind: 'autopilot.batch-decided',
          label: `Autopilot batch · ${accepted} accepted · ${rejected} rejected · ${skipped} skipped`,
          detail: {
            requestId: payload.requestId,
            accepted,
            rejected,
            skipped,
          },
        });
      }
      return { ok };
    },
  );

  // Feedback-trail viewer (Settings → Autopilot panel).
  ipcMain.handle(
    IpcChannels.autopilotFeedback,
    (
      _e,
      payload: { action: 'list' | 'read' | 'clear'; workflowId: string },
    ): unknown => {
      if (!payload?.workflowId) {
        throw new Error('autopilot:feedback requires workflowId');
      }
      if (payload.action === 'list') return listFeedback(payload.workflowId);
      if (payload.action === 'read') return readFeedback(payload.workflowId);
      if (payload.action === 'clear') {
        clearFeedback(payload.workflowId);
        deps.activity.record({
          kind: 'autopilot.feedback-cleared',
          label: `Autopilot feedback cleared · ${payload.workflowId}`,
          detail: { workflowId: payload.workflowId },
        });
        return { ok: true };
      }
      throw new Error(`unknown autopilot:feedback action "${payload.action}"`);
    },
  );
}
