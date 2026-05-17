import { fromPromise } from 'xstate';

import type { NodeHandlerInput } from './types.js';

/**
 * Reshape the previous step's output via a JavaScript expression.
 *
 * Params:
 *   {
 *     fn: string   // a JS expression body. `$` is the input.
 *                  // e.g. "$.data.issues.nodes.map(n => ({ id: n.id, title: n.title }))"
 *   }
 *
 * Output: whatever `fn($)` returns.
 *
 * Sandbox: `new Function('$', `return (${fn})`)`. No globals
 * (intentionally). No imports. No console. This is a personal-tool
 * threat model — the JSON is on the user's disk and they wrote it. If
 * we ever ship community workflows, this needs an actual sandbox
 * (vm2/isolated-vm/QuickJS).
 */

interface TransformParams {
  fn: string;
}

export const transformNode = fromPromise<
  unknown,
  NodeHandlerInput<TransformParams>
>(async ({ input }) => {
  const { params, prev } = input;
  if (!params.fn || typeof params.fn !== 'string') {
    throw new Error('transform: params.fn is required');
  }
  let compiled: (dollar: unknown) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    compiled = new Function('$', `return (${params.fn})`) as (
      d: unknown,
    ) => unknown;
  } catch (err) {
    throw new Error(
      `transform: failed to parse fn — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return compiled(prev);
  } catch (err) {
    throw new Error(
      `transform: fn threw — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});
