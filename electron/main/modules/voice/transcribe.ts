import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TranscribeProgress } from '@shared/types';

/**
 * Whisper transcription, isolated in a forked child process.
 *
 * The actual @huggingface/transformers + ONNX Runtime work runs
 * in transcribe-worker.ts. We use child_process.fork() (not
 * worker_threads) because ONNX Runtime can SIGSEGV on Apple
 * Silicon with the q8-quantized whisper-small model — and
 * worker_threads share the process, so a native crash there
 * would still take the whole app down. fork() gives us a real
 * OS process boundary.
 *
 * Worker is spun up lazily on the first transcribePcm call and
 * kept alive between calls. If it dies (crash, exit, SIGKILL),
 * pending promises reject and the next call spawns a fresh one.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, 'transcribe-worker.js');

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let worker: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<string, Pending>();
let emitProgress: (event: TranscribeProgress) => void = () => {};

export function setProgressEmitter(
  fn: (event: TranscribeProgress) => void,
): void {
  emitProgress = fn;
}

function ensureWorker(): ChildProcess {
  if (worker && !worker.killed && worker.connected) return worker;
  console.log('[transcribe] spawning worker', workerPath);
  worker = fork(workerPath, [], {
    // ELECTRON_RUN_AS_NODE makes Electron behave like vanilla
    // Node.js for the forked process. Without it the child tries
    // to be a second Electron app and refuses to load our script.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // 'advanced' uses structured clone so Float32Array transfers
    // efficiently — no JSON-of-numbers blowup.
    serialization: 'advanced',
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  worker.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as {
      type: string;
      id?: string;
      text?: string;
      message?: string;
      data?: unknown;
    };
    if (msg.type === 'progress' && msg.data) {
      const d = msg.data as {
        status?: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
      };
      if (d.status === 'download' || d.status === 'progress') {
        emitProgress({
          status: 'downloading',
          file: d.file,
          progress: d.progress,
          loaded: d.loaded,
          total: d.total,
        });
      } else if (d.status === 'ready' || d.status === 'done') {
        emitProgress({ status: 'loading' });
      }
      return;
    }
    const id = msg.id;
    if (!id) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (msg.type === 'transcribe-ok') entry.resolve(msg.text ?? '');
    else if (msg.type === 'warmup-ok') entry.resolve(undefined);
    else if (msg.type === 'error') {
      entry.reject(
        new Error(msg.message ?? 'Transcribe worker reported an error'),
      );
    }
  });
  worker.on('exit', (code, signal) => {
    console.error(
      `[transcribe] worker exited code=${code} signal=${signal} (pending=${pending.size})`,
    );
    const err = new Error(
      `Transcription worker exited (${signal ?? `code ${code}`}). It may have crashed on the model — try again.`,
    );
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    worker = null;
  });
  worker.on('error', (err) => {
    console.error('[transcribe] worker error', err);
  });
  return worker;
}

function call<T>(message: Record<string, unknown>): Promise<T> {
  const w = ensureWorker();
  const id = String(nextId++);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    try {
      w.send({ ...message, id });
    } catch (err) {
      pending.delete(id);
      reject(
        err instanceof Error
          ? err
          : new Error(`Failed to dispatch to worker: ${String(err)}`),
      );
    }
  });
}

export async function transcribePcm(pcm: Float32Array): Promise<string> {
  console.log(
    `[transcribe] pcm received samples=${pcm.length} (~${(pcm.length / 16000).toFixed(1)}s)`,
  );
  emitProgress({ status: 'transcribing' });
  try {
    const text = await call<string>({ type: 'transcribe', pcm });
    emitProgress({ status: 'done' });
    return text;
  } catch (err) {
    emitProgress({ status: 'done' });
    console.error('[transcribe] failed', err);
    throw err;
  }
}

/**
 * Pre-load the model so the first transcription doesn't double
 * as a download. Safe to call multiple times.
 */
export async function warmUp(): Promise<void> {
  try {
    await call<void>({ type: 'warmup' });
    emitProgress({ status: 'ready' });
  } catch (err) {
    console.error('[transcribe] warmUp failed', err);
  }
}
