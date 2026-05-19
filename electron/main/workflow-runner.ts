import { EventEmitter } from 'node:events';

import { nanoid } from 'nanoid';
import { type Actor, createActor } from 'xstate';

import type { WorkflowDef, WorkflowRun, WorkflowRunStep } from '@shared/types';

import {
  getWorkflowRun as dbGetWorkflowRun,
  listWorkflowRuns as dbListWorkflowRuns,
  upsertWorkflowRun,
} from './db.js';
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

/** Cap on serialized output we keep per step. Workflows can produce
 *  large payloads (full Slack search responses, etc.) — we want enough
 *  to be useful for debugging without bloating run history. */
const MAX_OUTPUT_BYTES = 100_000;

function captureOutput(value: unknown): {
  value: unknown;
  truncated: boolean;
} {
  if (value === undefined) return { value: undefined, truncated: false };
  // Strings are returned verbatim if under the cap.
  if (typeof value === 'string') {
    if (value.length <= MAX_OUTPUT_BYTES) return { value, truncated: false };
    return {
      value: value.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]',
      truncated: true,
    };
  }
  // Anything else — serialize once to measure, then either keep as-is
  // or substitute a stringified-and-clipped form.
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value: '[unserializable output]', truncated: true };
  }
  if (json.length <= MAX_OUTPUT_BYTES) return { value, truncated: false };
  return {
    value: json.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]',
    truncated: true,
  };
}

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
    trigger: 'cron' | 'manual' | 'autopilot' | 'inbox-event',
  ): WorkflowRun {
    if (!this.nodeCtx) {
      throw new Error('WorkflowRunner: setNodeContext() must be called first');
    }
    // Thread the workflow id onto a per-run ctx so nodes can resolve
    // per-scenario state (autopilot feedback file path, draft-output
    // id prefix). Compile-time only — the original shared ctx isn't
    // mutated.
    const runCtx: WorkflowNodeContext = { ...this.nodeCtx, workflowId: def.id };
    const compile = compileWorkflow(def, runCtx);
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
      this.persist(failed);
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
    // Persist the initial row so a crash mid-run leaves a 'running'
    // marker on disk — the renderer can surface it as "stuck" rather
    // than the row vanishing entirely.
    this.persist(run);

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
        // Capture the step's output the first time we see it as
        // completed — ctx.outputs[i] is what the actor returned, kept
        // around for downstream steps. The output is the same on every
        // subsequent transition, so we only assign once.
        let output = s.output;
        let outputTruncated = s.outputTruncated;
        if (next === 'completed' && s.status !== 'completed') {
          const captured = captureOutput(ctx.outputs[i]);
          output = captured.value;
          outputTruncated = captured.truncated;
        }
        const stepError = ctx.stepErrors?.[i] ?? null;
        return {
          ...s,
          status: next as WorkflowRunStep['status'],
          startedAt: startedAt || s.startedAt,
          endedAt,
          ...(output !== undefined ? { output } : {}),
          ...(outputTruncated ? { outputTruncated: true } : {}),
          ...(stepError ? { error: stepError } : {}),
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
      this.persist(run);
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
    this.persist(handle.run);
    this.emit('run-changed', { ...handle.run });
    return true;
  }

  get(runId: string): WorkflowRun | null {
    // Live run wins; fall back to disk so a restart-survived run is
    // still inspectable from the renderer's Runs tab.
    const live = this.runs.get(runId)?.run;
    if (live) return live;
    const persisted = dbGetWorkflowRun(runId);
    return persisted ? (persisted as WorkflowRun) : null;
  }

  /**
   * Newest first. Merges live in-memory runs (which may not have
   * been flushed to disk yet at the moment of the call) with the
   * persistent history. SQLite is the source of truth past the live
   * window; in-memory takes precedence for the same id.
   */
  list(workflowId?: string): WorkflowRun[] {
    const live = [...this.runs.values()].map((h) => h.run);
    const liveFiltered = workflowId
      ? live.filter((r) => r.workflowId === workflowId)
      : live;
    const persisted = dbListWorkflowRuns(workflowId, 200) as WorkflowRun[];
    const seen = new Set(liveFiltered.map((r) => r.id));
    const merged: WorkflowRun[] = [
      ...liveFiltered,
      ...persisted.filter((r) => !seen.has(r.id)),
    ];
    return merged.sort((a, b) => b.startedAt - a.startedAt);
  }

  private persist(run: WorkflowRun): void {
    try {
      upsertWorkflowRun({
        id: run.id,
        workflowId: run.workflowId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
        trigger: run.trigger,
        snapshot: run,
      });
    } catch (err) {
      console.warn(
        '[workflow-runner] failed to persist run',
        run.id,
        err instanceof Error ? err.message : err,
      );
    }
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
