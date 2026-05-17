import {
  type AnyStateMachine,
  assign,
  createMachine,
} from 'xstate';

import type { WorkflowDef } from '@shared/types';

import { NODE_REGISTRY, type WorkflowNodeContext } from './workflow-nodes/index.js';

/**
 * Compile a flat-pipeline WorkflowDef into an XState machine. Each
 * pipeline step becomes a state with an `invoke` of the matching
 * node actor; transitions on `onDone` advance to the next step,
 * on `onError` route to a shared `errored` final state.
 *
 * The user never sees this — they edit the flat JSON, we compile
 * at load time. XState earns us cancellation, error boundaries, and
 * a clean upgrade path to branching/parallel without changing the
 * user-facing shape.
 */

export interface WorkflowMachineContext {
  /** Outputs from each completed step, indexed by step index. */
  outputs: unknown[];
  /** Captured error message when a step fails. */
  error: string | null;
  /** Per-step status, indexed by step. Used by the runner to emit
   *  WorkflowRunStep events back to the UI. */
  stepStatus: Array<'pending' | 'running' | 'completed' | 'errored' | 'skipped'>;
  /** Index of the most recent step that started. -1 before any step
   *  runs. The runner reads this on each context change to know which
   *  step's status just transitioned. */
  currentStep: number;
}

export interface CompileResult {
  machine: AnyStateMachine;
  /** Hand-back of the workflow we compiled — convenient so the runner
   *  doesn't have to thread the def through separately. */
  def: WorkflowDef;
  /** Steps that referenced unknown node types — surfaced as errors at
   *  compile time so the workflow doesn't pretend to be runnable. */
  unknownTypes: string[];
}

export function compileWorkflow(
  def: WorkflowDef,
  ctx: WorkflowNodeContext,
): CompileResult {
  const unknownTypes: string[] = [];
  for (const node of def.pipeline) {
    if (!NODE_REGISTRY[node.type]) unknownTypes.push(node.type);
  }

  // The actor registry tells XState which `fromPromise` actor to
  // spawn for each step's `invoke.src`. We assign one per step so a
  // workflow that uses the same type twice still gets distinct
  // invoke entries — matters for tracking which step is running.
  const actors: Record<string, unknown> = {};
  def.pipeline.forEach((node, i) => {
    const handler = NODE_REGISTRY[node.type];
    if (handler) actors[`node_${i}`] = handler;
  });

  // Build state nodes step by step. Typed as `any` because XState's
  // strict StatesConfig type makes dynamic graph construction
  // painful; the shape we produce is correct, just hard to express.
  const states: Record<string, unknown> = {
    idle: {
      on: { RUN: def.pipeline.length > 0 ? 'step_0' : 'completed' },
    },
  };

  def.pipeline.forEach((node, i) => {
    const handler = NODE_REGISTRY[node.type];
    const nextState = i === def.pipeline.length - 1 ? 'completed' : `step_${i + 1}`;
    if (!handler) {
      // Unknown node type — short-circuit to errored. The scheduler
      // refuses to start workflows with unknownTypes anyway; this is
      // belt-and-suspenders so the compiled machine stays a valid
      // graph regardless.
      states[`step_${i}`] = {
        entry: assign({
          stepStatus: ({ context }: { context: unknown }) => {
            const c = context as WorkflowMachineContext;
            const next = [...c.stepStatus];
            next[i] = 'errored';
            return next;
          },
          error: `Unknown node type: ${node.type}`,
          currentStep: i,
        }),
        always: 'errored',
      };
      return;
    }

    states[`step_${i}`] = {
      entry: assign({
        stepStatus: ({ context }: { context: unknown }) => {
          const c = context as WorkflowMachineContext;
          const next = [...c.stepStatus];
          next[i] = 'running';
          return next;
        },
        currentStep: i,
      }),
      invoke: {
        id: `node_${i}_${node.type}`,
        src: `node_${i}`,
        input: ({ context }: { context: unknown }) => ({
          params: node.params ?? {},
          prev: i === 0 ? undefined : (context as WorkflowMachineContext).outputs[i - 1],
          ctx,
        }),
        onDone: {
          target: nextState,
          // event.output is the value returned by the fromPromise actor.
          // XState v5's typed assigner is fiddly for dynamic graphs — we
          // cast through unknown to pull `output` off the event shape.
          actions: assign({
            outputs: ({ context, event }: { context: unknown; event: unknown }) => {
              const c = context as WorkflowMachineContext;
              const next = [...c.outputs];
              next[i] = (event as { output: unknown }).output;
              return next;
            },
            stepStatus: ({ context }: { context: unknown }) => {
              const c = context as WorkflowMachineContext;
              const next = [...c.stepStatus];
              next[i] = 'completed';
              return next;
            },
          }),
        },
        onError: {
          target: 'errored',
          actions: assign({
            stepStatus: ({ context }: { context: unknown }) => {
              const c = context as WorkflowMachineContext;
              const next = [...c.stepStatus];
              next[i] = 'errored';
              return next;
            },
            error: ({ event }: { event: unknown }) => {
              const err = (event as { error: unknown }).error;
              return err instanceof Error
                ? err.message
                : String(err ?? 'unknown error');
            },
          }),
        },
      },
    };
  });

  states['completed'] = { type: 'final' };
  states['errored'] = { type: 'final' };

  const machine = createMachine({
    id: def.id,
    initial: 'idle',
    context: {
      outputs: new Array<unknown>(def.pipeline.length),
      error: null,
      stepStatus: new Array(def.pipeline.length).fill('pending') as Array<
        'pending' | 'running' | 'completed' | 'errored' | 'skipped'
      >,
      currentStep: -1,
    } as WorkflowMachineContext,
    // Loose cast: see comment on `states` above.
    states: states as never,
  }).provide({
    actors: actors as never,
  });

  return { machine, def, unknownTypes };
}
