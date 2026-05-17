import { execFile } from 'node:child_process';

import { fromPromise } from 'xstate';

import type { NodeHandlerInput } from './types.js';

/**
 * Run a binary via execFile (NOT spawn-shell — no shell interpretation,
 * args are an array). Use for `gh`, `git`, anything CLI.
 *
 * Params:
 *   {
 *     cmd: string             // e.g. 'gh'
 *     args?: string[]
 *     cwd?: string            // default jarvisRoot
 *     timeoutMs?: number      // default 30s
 *     env?: Record<string, string>  // merged onto process.env
 *   }
 *
 * Output: stdout as a string. Non-zero exit → reject.
 */

interface ShellParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export const shellNode = fromPromise<string, NodeHandlerInput<ShellParams>>(
  async ({ input, signal }) => {
    const { params, ctx } = input;
    if (!params.cmd || typeof params.cmd !== 'string') {
      throw new Error('shell: params.cmd is required');
    }
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        params.cmd,
        params.args ?? [],
        {
          cwd: params.cwd ?? ctx.jarvisRoot,
          timeout: params.timeoutMs ?? 30_000,
          env: { ...process.env, ...(params.env ?? {}) },
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.toString());
        },
      );
      const onAbort = (): void => {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', () => signal.removeEventListener('abort', onAbort));
    });
  },
);
