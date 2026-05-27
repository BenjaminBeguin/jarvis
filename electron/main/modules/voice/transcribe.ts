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
    return collapseRepetitions(text);
  } catch (err) {
    emitProgress({ status: 'done' });
    console.error('[transcribe] failed', err);
    throw err;
  }
}

/**
 * Whisper-base has a well-known failure mode: on quiet / silence /
 * music it can latch onto a short phrase and loop it dozens of
 * times ("be going to be going to be going..."). The model output
 * is irrecoverable as content but easy to detect: any n-gram (2 to
 * ~10 words) repeated 4+ times in a row is almost certainly a
 * hallucination.
 *
 * We collapse those runs to a single occurrence followed by a
 * marker so the reader knows something was elided rather than
 * spoken once. The non-looping portions of the transcript are left
 * unchanged.
 *
 * Cheap O(n*k) pass — words ≤ ~30 000 for an hour of dense talk,
 * k ≤ 10. Runs in single-digit ms on real transcripts.
 *
 * Exported so the same scrub can be applied to live-chunk
 * stitched transcripts in the renderer too if needed.
 */
export function collapseRepetitions(text: string): string {
  if (!text || text.length < 80) return text;
  // Tokenise but preserve original whitespace + punctuation by
  // recording word offsets. Simpler approach: split on whitespace,
  // detect repeats, rebuild with single spaces. We lose original
  // formatting nuance but Whisper output is already a flat string.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 16) return text;
  const norm = words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));

  // For each candidate n-gram size (largest first to catch big
  // loops before short ones inside them), scan for consecutive
  // repeats ≥ MIN_REPEATS.
  const MIN_REPEATS = 4;
  const MAX_N = 10;
  const removed: boolean[] = new Array(words.length).fill(false);
  let collapsedCount = 0;
  for (let n = MAX_N; n >= 2; n--) {
    let i = 0;
    while (i + n * MIN_REPEATS <= words.length) {
      if (removed[i]) { i++; continue; }
      // Count how many times the n-gram starting at i repeats
      // contiguously (allowing for already-removed positions to
      // be skipped — they don't break the run).
      let repeats = 1;
      let cursor = i + n;
      while (cursor + n <= words.length) {
        // Skip over already-removed positions.
        while (cursor < words.length && removed[cursor]) cursor++;
        if (cursor + n > words.length) break;
        let match = true;
        for (let k = 0; k < n; k++) {
          if (norm[i + k] !== norm[cursor + k]) { match = false; break; }
          if (!norm[i + k]) { match = false; break; }
        }
        if (!match) break;
        repeats++;
        cursor += n;
      }
      if (repeats >= MIN_REPEATS) {
        // Mark everything from i+n through the last copy as removed.
        for (let k = i + n; k < cursor; k++) removed[k] = true;
        collapsedCount++;
        i = cursor;
      } else {
        i++;
      }
    }
  }
  if (collapsedCount === 0) return text;
  const out: string[] = [];
  let lastWasRemoved = false;
  for (let i = 0; i < words.length; i++) {
    if (removed[i]) {
      if (!lastWasRemoved) out.push('… [repeated phrase elided] …');
      lastWasRemoved = true;
      continue;
    }
    lastWasRemoved = false;
    out.push(words[i]!);
  }
  console.log(
    `[transcribe] collapsed ${collapsedCount} repetition loop(s) from local Whisper output`,
  );
  return out.join(' ');
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
