import { execFile } from 'node:child_process';

import { fromPromise } from 'xstate';

import type { NodeHandlerInput } from './types.js';

/**
 * Run an AppleScript via `osascript`. macOS only — calling this on
 * other platforms throws. Use for Calendar.app, Reminders.app, Notes
 * — anything that exposes an AppleScript surface.
 *
 * Params:
 *   {
 *     script: string         // the AppleScript body, passed via -e
 *     timeoutMs?: number     // default 10s
 *   }
 *
 * Output: stdout as a string (whitespace trimmed).
 */

interface OsascriptParams {
  script: string;
  timeoutMs?: number;
}

export const osascriptNode = fromPromise<
  string,
  NodeHandlerInput<OsascriptParams>
>(async ({ input, signal }) => {
  const { params } = input;
  if (process.platform !== 'darwin') {
    throw new Error('osascript: macOS only');
  }
  if (!params.script || typeof params.script !== 'string') {
    throw new Error('osascript: params.script is required');
  }
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'osascript',
      ['-e', params.script],
      { timeout: params.timeoutMs ?? 10_000 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.toString().trim());
      },
    );
    // Forward XState's cancellation into the child process.
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
});
