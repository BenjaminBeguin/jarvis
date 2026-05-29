import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parent-side host for the embedding worker. Mirrors transcribe.ts
 * (electron/main/modules/voice/transcribe.ts) — fork on first use,
 * keep alive, restart on crash.
 *
 * Usage:
 *   await warmUpEmbeddings();             // optional pre-load
 *   const vecs = await embed(['text']);   // returns Float32Array[]
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, 'embed-worker.js');

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let worker: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<string, Pending>();

function ensureWorker(): ChildProcess {
  if (worker && !worker.killed && worker.connected) return worker;
  console.log('[embed] spawning worker', workerPath);
  worker = fork(workerPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    serialization: 'advanced',
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  worker.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as {
      type: string;
      id?: string;
      vectors?: number[][];
      message?: string;
    };
    if (msg.type === 'progress') return; // currently unused
    const id = msg.id;
    if (!id) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (msg.type === 'embed-ok') entry.resolve(msg.vectors ?? []);
    else if (msg.type === 'warmup-ok') entry.resolve(undefined);
    else if (msg.type === 'error') {
      entry.reject(new Error(msg.message ?? 'embed worker error'));
    }
  });
  worker.on('exit', (code, signal) => {
    console.error(
      `[embed] worker exited code=${code} signal=${signal} (pending=${pending.size})`,
    );
    const err = new Error(
      `Embedding worker exited (${signal ?? `code ${code}`}). Will respawn on next call.`,
    );
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    worker = null;
  });
  worker.on('error', (err) => {
    console.error('[embed] worker error', err);
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
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Embed an array of texts to 384-d normalized float vectors. Returns
 * one vector per input in matching order. Empty strings get a zero
 * vector — caller's responsibility to filter if that matters.
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const arr = await call<number[][]>({ type: 'embed', texts });
  return arr.map((v) => Float32Array.from(v));
}

/** Lazy-load the model so the first real embed() doesn't pay the
 *  download/load tax. Safe to call multiple times. */
export async function warmUpEmbeddings(): Promise<void> {
  try {
    await call<void>({ type: 'warmup' });
  } catch (err) {
    console.error('[embed] warmUp failed', err);
  }
}

export function shutdownEmbedWorker(): void {
  if (worker && !worker.killed) {
    worker.kill();
  }
  worker = null;
  pending.clear();
}
