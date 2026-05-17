import { EventEmitter } from 'node:events';

import { nanoid } from 'nanoid';
import { type Actor, createActor } from 'xstate';

import type { WorkflowDef, WorkflowRun, WorkflowRunStep } from '@shared/types';

import { compileWorkflow, type WorkflowMachineContext } from './workflow-compile.js';
import type { WorkflowNodeContext } from './workflow-nodes/index.js';

/**
 * Spawns + supervises XState actors for workflow runs. Each run gets
 * a unique id, in-memory WorkflowRun record, and a live actor.
 *
 * Emitters:
 *   - 'run-changed' (run: WorkflowRun) — fires on every state transition
 *     and once more on terminal status. The renderer subscribes via
 *     IPC; the FlowStream river uses this to advance its orb stage.
 *
 * Memory: caps recent runs at MAX_RECENT_RUNS (60); older runs
 * dropped from the in-memory store. SQLite persistence is a v1.5
 * follow-up.
 */

const MAX_RECENT_RUNS = 60;

interface RunHandle {
  actor: Actor<ReturnType<typeof compileWorkflow>['machine']>;
  run: WorkflowRun;
}

export class WorkflowRunner extends EventEmitter {
  private runs = new Map<string, RunHandle>();
  private nodeCtx: WorkflowNodeContext | null = null;

  setNodeContext(ctx: WorkflowNodeContext): void {
    this.nodeCtx = ctx;
  }

  /**
   * Kick off a workflow. Returns the WorkflowRun snapshot at start
   * time. Listen to 'run-changed' for updates.
   */
  run(
    def: WorkflowDef,
    trigger: 'cron' | 'manual' | 'event',
  ): WorkflowRun {
    if (!this.nodeCtx) {
      throw new Error('WorkflowRunner: setNodeContext() must be called first');
    }
    const compile = compileWorkflow(def, this.nodeCtx);
    if (compile.unknownTypes.length) {
      // Don't even spawn — surface the misconfig as an errored run.
      const failed: WorkflowRun = {
        id: nanoid(8),
        workflowId: def.id,
        trigger,
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: 'errored',
        steps: [],
        error: `Unknown node types: ${compile.unknownTypes.join(', ')}`,
      };
      this.storeRun(failed);
      this.emit('run-changed', failed);
      return failed;
    }

    const run: WorkflowRun = {
      id: nanoid(8),
      workflowId: def.id,
      trigger,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      steps: def.pipeline.map((node, i) => ({
        index: i,
        nodeType: node.type,
        startedAt: 0,
        endedAt: null,
        status: 'pending',
      })),
    };

    const actor = createActor(compile.machine);
    const handle: RunHandle = { actor, run };
    this.storeRun(run);

    // Subscribe to the actor BEFORE starting so we don't miss the
    // initial transition.
    actor.subscribe((snapshot) => {
      const ctx = snapshot.context as WorkflowMachineContext;
      // Sync per-step status from the machine context. The compiler
      // updates ctx.stepStatus on each transition.
      run.steps = run.steps.map((s, i) => {
        const next = ctx.stepStatus[i] ?? s.status;
        const prevStatus = s.status;
        const startedAt =
          prevStatus !== 'running' && next === 'running'
            ? Date.now()
            : s.startedAt;
        const endedAt =
          (next === 'completed' || next === 'errored' || next === 'skipped') &&
          s.endedAt == null
            ? Date.now()
            : s.endedAt;
        return {
          ...s,
          status: next as WorkflowRunStep['status'],
          startedAt: startedAt || s.startedAt,
          endedAt,
        };
      });

      // Terminal mapping. When the machine reaches a terminal state,
      // any steps still marked `pending` never got reached — flip them
      // to `skipped` so the UI doesn't show them as eternally pending.
      if (snapshot.value === 'completed') {
        run.status = 'completed';
        run.endedAt = Date.now();
      } else if (snapshot.value === 'errored') {
        run.status = 'errored';
        run.endedAt = Date.now();
        run.error = ctx.error ?? undefined;
        run.steps = run.steps.map((s) =>
          s.status === 'pending' ? { ...s, status: 'skipped' } : s,
        );
      }
      this.emit('run-changed', { ...run });
    });

    actor.start();
    actor.send({ type: 'RUN' });
    return { ...run };
  }

  /** Stop a running workflow. No-op for already-terminal runs. */
  stop(runId: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    if (handle.run.status !== 'running') return false;
    handle.actor.stop();
    handle.run.status = 'aborted';
    handle.run.endedAt = Date.now();
    handle.run.steps = handle.run.steps.map((s) =>
      s.status === 'running'
        ? { ...s, status: 'errored', endedAt: Date.now() }
        : s,
    );
    this.emit('run-changed', { ...handle.run });
    return true;
  }

  get(runId: string): WorkflowRun | null {
    return this.runs.get(runId)?.run ?? null;
  }

  /** Newest first. */
  list(workflowId?: string): WorkflowRun[] {
    const all = [...this.runs.values()].map((h) => h.run);
    const filtered = workflowId
      ? all.filter((r) => r.workflowId === workflowId)
      : all;
    return filtered.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Stop everything — used during app shutdown. */
  stopAll(): void {
    for (const [, h] of this.runs) {
      if (h.run.status === 'running') h.actor.stop();
    }
  }

  private storeRun(run: WorkflowRun): void {
    const handle = this.runs.get(run.id);
    if (handle) {
      handle.run = run;
    } else {
      // We don't have an actor handle for synthetically-failed runs
      // (e.g. unknownTypes). Insert a placeholder.
      this.runs.set(run.id, {
        actor: null as unknown as Actor<
          ReturnType<typeof compileWorkflow>['machine']
        >,
        run,
      });
    }
    this.prune();
  }

  private prune(): void {
    if (this.runs.size <= MAX_RECENT_RUNS) return;
    const sorted = [...this.runs.entries()].sort(
      ([, a], [, b]) => b.run.startedAt - a.run.startedAt,
    );
    for (const [id] of sorted.slice(MAX_RECENT_RUNS)) {
      const handle = this.runs.get(id);
      if (handle?.actor && handle.run.status === 'running') {
        // Belt-and-suspenders — shouldn't happen since runs cap before reaching here.
        try {
          handle.actor.stop();
        } catch {
          // already stopped
        }
      }
      this.runs.delete(id);
    }
  }
}
