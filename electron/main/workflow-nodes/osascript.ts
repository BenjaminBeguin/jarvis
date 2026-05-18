import { execFile } from 'node:child_process';

import { fromPromise } from 'xstate';

import type { NodeHandlerInput } from './types.js';

/**
 * Run a script via `osascript`. macOS only — calling this on other
 * platforms throws. Use for Calendar.app, Reminders.app, Notes —
 * anything that exposes a scripting interface.
 *
 * Params:
 *   {
 *     script: string                              // body passed via -e
 *     language?: 'applescript' | 'javascript'     // default 'applescript'
 *       'javascript' = JXA (JavaScript for Automation). Same host,
 *       JS syntax, native dates, easy JSON output. Strongly preferred
 *       for anything beyond trivial AppleScript — date math + string
 *       concatenation in AppleScript is a tarpit.
 *     timeoutMs?: number                          // default 10s
 *   }
 *
 * Output: stdout as a string (whitespace trimmed).
 */

interface OsascriptParams {
  script: string;
  language?: 'applescript' | 'javascript';
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
  const args =
    params.language === 'javascript'
      ? ['-l', 'JavaScript', '-e', params.script]
      : ['-e', params.script];
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'osascript',
      args,
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
