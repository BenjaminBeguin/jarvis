import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Forked embedding worker for the artifact substrate. Mirrors the
 * Whisper transcribe worker pattern (electron/main/modules/voice/
 * transcribe-worker.ts) — same fork() isolation, same lazy model
 * load, same JSON-over-IPC protocol.
 *
 * Why a fork: Transformers.js / ONNX Runtime can SIGSEGV during model
 * load on some platforms. Crashing the embedding worker shouldn't
 * take Electron down — the parent restarts us on the next call.
 *
 * Protocol:
 *
 *   parent → child:
 *     { type: 'warmup', id }
 *     { type: 'embed', id, texts: string[] }
 *
 *   child → parent:
 *     { type: 'progress', data }
 *     { type: 'warmup-ok', id }
 *     { type: 'embed-ok', id, vectors: number[][] }  // 384-dim each
 *     { type: 'error', id, message }
 */

type FeatureExtractor = (
  texts: string | string[],
  options?: Record<string, unknown>,
) => Promise<{ data: Float32Array; dims: number[] }>;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIM = 384;

let extractor: FeatureExtractor | null = null;
let loading: Promise<FeatureExtractor> | null = null;

interface WarmupRequest {
  type: 'warmup';
  id: string;
}
interface EmbedRequest {
  type: 'embed';
  id: string;
  texts: string[];
}
type Request = WarmupRequest | EmbedRequest;

function send(msg: Record<string, unknown>): void {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

async function load(): Promise<FeatureExtractor> {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = (async () => {
    const cacheDir = join(homedir(), '.jarvis', 'models');
    mkdirSync(cacheDir, { recursive: true });
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;
    const p = (await pipeline('feature-extraction', MODEL_NAME, {
      // Quantised int8 is ~22 MB and runs comfortably on CPU. MiniLM
      // is small enough that quant accuracy loss is negligible for
      // semantic similarity.
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (data: unknown) => {
        send({ type: 'progress', data });
      },
    } as unknown as Parameters<typeof pipeline>[2])) as unknown as FeatureExtractor;
    extractor = p;
    return p;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Mean-pool the per-token feature matrix to a single 384-d vector,
 *  then L2-normalize. Cosine similarity reduces to a dot product on
 *  normalized vectors — saves cycles in the KNN path. */
function meanPoolL2(data: Float32Array, dims: number[]): Float32Array {
  // dims = [batch=1, seq_len, hidden=384]
  const seqLen = dims[1] ?? 1;
  const hidden = dims[2] ?? EMBED_DIM;
  const out = new Float32Array(hidden);
  for (let t = 0; t < seqLen; t++) {
    const base = t * hidden;
    for (let h = 0; h < hidden; h++) {
      out[h]! += data[base + h]!;
    }
  }
  for (let h = 0; h < hidden; h++) out[h]! /= seqLen;
  // L2 normalize
  let norm = 0;
  for (let h = 0; h < hidden; h++) norm += out[h]! * out[h]!;
  norm = Math.sqrt(norm) || 1;
  for (let h = 0; h < hidden; h++) out[h]! /= norm;
  return out;
}

async function handle(msg: Request): Promise<void> {
  try {
    if (msg.type === 'warmup') {
      await load();
      send({ type: 'warmup-ok', id: msg.id });
      return;
    }
    if (msg.type === 'embed') {
      const w = await load();
      const vectors: number[][] = [];
      // Process serially — batching saves time but blows past
      // MiniLM's 256-token window if any text is long. The chunker
      // upstream already caps per chunk so each call is small.
      for (const text of msg.texts) {
        // pooling: 'mean' + normalize: true would do this in-lib, but
        // it doesn't match what sqlite-vec wants (it wants a flat
        // Float32 with no L2 done by the lib's normalizer because
        // dims may vary). Do it explicitly.
        const out = await w(text || '', { pooling: 'none' });
        const v = meanPoolL2(out.data, out.dims);
        // Convert to plain JS array for IPC serialization — Float32Array
        // crosses the fork boundary via advanced serialization but we
        // emit number[] for cleaner JSON shape on the parent side.
        vectors.push(Array.from(v));
      }
      send({ type: 'embed-ok', id: msg.id, vectors });
    }
  } catch (err) {
    send({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

process.on('message', (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const req = msg as Request;
  if (req.type !== 'warmup' && req.type !== 'embed') return;
  void handle(req);
});

process.on('uncaughtException', (err) => {
  console.error('[embed-worker:uncaught]', err);
});

console.log(`[embed-worker] ready pid=${process.pid}`);
