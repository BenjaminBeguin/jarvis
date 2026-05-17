import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { WorkflowDef } from '@shared/types';

import { broadcast } from '../windows.js';
import type { IpcDeps } from './types.js';

/**
 * IPC for the Workflows tab. List / save / delete from the renderer;
 * Run-now and Stop dispatched here too.
 *
 * Broadcasts:
 *   - `workflowsChanged` on every store change
 *   - `workflowRunChanged` on every runner state transition
 */
export function registerWorkflowsIpc({
  workflows,
  workflowRunner,
  workflowScheduler,
  activity,
}: IpcDeps): void {
  workflows.on('changed', (list: WorkflowDef[]) => {
    broadcast(IpcChannels.workflowsChanged, list);
  });
  workflowRunner.on('run-changed', (run) => {
    broadcast(IpcChannels.workflowRunChanged, run);
  });

  ipcMain.handle(IpcChannels.listWorkflows, () => ({
    workflows: workflows.list(),
    errors: workflows.errors(),
  }));

  ipcMain.handle(
    IpcChannels.saveWorkflow,
    (_e, def: WorkflowDef): { ok: boolean; message?: string } => {
      const before = workflows.get(def.id);
      try {
        workflows.save(def);
        activity.record({
          kind: before ? 'workflow.updated' : 'workflow.created',
          label: before
            ? `Workflow updated · ${def.name}`
            : `Workflow created · ${def.name}`,
          detail: { id: def.id, name: def.name, trigger: def.trigger },
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(IpcChannels.deleteWorkflow, (_e, id: string) => {
    const before = workflows.get(id);
    const ok = workflows.remove(id);
    if (ok && before) {
      activity.record({
        kind: 'workflow.deleted',
        label: `Workflow deleted · ${before.name}`,
        detail: { id, name: before.name },
      });
    }
    return ok;
  });

  ipcMain.handle(IpcChannels.runWorkflow, (_e, id: string) => {
    const def = workflows.get(id);
    if (!def) {
      return { ok: false, message: `Workflow not found: ${id}` };
    }
    try {
      const run = workflowScheduler.runManually
        ? (workflowScheduler.runManually(id), workflowRunner.list(id)[0])
        : workflowRunner.run(def, 'manual');
      activity.record({
        kind: 'workflow.ran-manually',
        label: `Workflow fired manually · ${def.name}`,
        detail: { id, runId: run?.id ?? null },
      });
      return { ok: true, run };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IpcChannels.stopWorkflowRun, (_e, runId: string) =>
    workflowRunner.stop(runId),
  );

  ipcMain.handle(IpcChannels.readWorkflowRun, (_e, runId: string) =>
    workflowRunner.get(runId),
  );

  ipcMain.handle(IpcChannels.listWorkflowRuns, (_e, workflowId?: string) =>
    workflowRunner.list(workflowId),
  );
}
