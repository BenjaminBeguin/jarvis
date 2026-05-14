import { type ChildProcess, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';

import type { TaskSummary } from '@shared/types';

import type { TaskRunner } from './task-runner.js';

/**
 * Manual escape hatch: spawn a real shell command and stream its output
 * into the HUD via the existing TaskRunner external-task plumbing, with
 * no Claude in the loop. Same shell environment Jarvis tasks have access
 * to (PATH, gh, npm, etc.), same observability + abort path.
 *
 * Used by the /sh palette intent. Also useful as a "I know what I want,
 * just run it" backup when an agent-driven workflow misfires.
 */
export class ShellRunner {
  private children = new Map<string, ChildProcess>();

  constructor(private runner: TaskRunner) {}

  launch(cmd: string): TaskSummary {
    const trimmed = cmd.trim();
    const title = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
    const summary: TaskSummary = {
      id: nanoid(8),
      skillId: null,
      title: `$ ${title}`,
      status: 'running',
      origin: 'palette',
      startedAt: Date.now(),
      endedAt: null,
      costUsd: 0,
      inputPreview: trimmed,
    };
    this.runner.registerExternal(summary);

    // Spawn with shell:true so pipes / redirects / globs work as the user
    // types them. cwd defaults to $HOME like Jarvis tasks; user can `cd`
    // first if they need a different working directory.
    const child = spawn(trimmed, [], {
      shell: true,
      cwd: homedir(),
      env: process.env,
    });
    this.children.set(summary.id, child);

    // Wire the runner's abort signal to SIGTERM the child. When the user
    // hits Stop in the HUD, abortTask → runner.abort → AbortController
    // signal → this listener.
    const signal = this.runner.getAbortSignal(summary.id);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          try {
            child.kill('SIGTERM');
          } catch {
            // already gone; the close handler will resolve it.
          }
        },
        { once: true },
      );
    }

    const emit = (text: string, isError = false) => {
      // Synthesize an SDKMessage-shaped event so the HUD / TaskDetail
      // renderers pick it up like a regular assistant text block. stderr
      // is also flagged as text — Whisper through the same path. The
      // user can tell stderr by content.
      this.runner.recordExternalEvent(summary.id, {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: isError ? text : text, isError },
          ],
        },
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      emit(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      emit(chunk.toString('utf8'), true);
    });
    child.on('error', (err) => {
      emit(`spawn error: ${err.message}\n`, true);
      this.cleanup(summary.id, 'errored');
    });
    child.on('close', (code, sig) => {
      const ok = code === 0 && !sig;
      // Synthetic result event so the HUD's status badge flips to done.
      this.runner.recordExternalEvent(summary.id, {
        type: 'result',
        subtype: ok ? 'success' : 'error_during_execution',
        total_cost_usd: 0,
        duration_ms: Date.now() - summary.startedAt,
        is_error: !ok,
        ...(code != null ? { exit_code: code } : {}),
        ...(sig ? { signal: sig } : {}),
      });
      this.cleanup(
        summary.id,
        signal?.aborted ? 'aborted' : ok ? 'completed' : 'errored',
      );
    });

    return summary;
  }

  private cleanup(
    taskId: string,
    status: 'completed' | 'errored' | 'aborted',
  ): void {
    this.children.delete(taskId);
    this.runner.updateExternalStatus(taskId, status, Date.now());
  }

  abortAll(): void {
    for (const child of this.children.values()) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.children.clear();
  }
}
