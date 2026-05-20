import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Stand-alone Whisper transcription worker. Forked from
 * electron/main/transcribe.ts so a native crash inside ONNX
 * Runtime takes only THIS process down — not the whole Electron
 * app. The parent restarts us on the next call.
 *
 * Protocol: parent → child JSON messages over the fork() IPC
 * channel (advanced serialization, so Float32Array transfers
 * natively):
 *
 *   { type: 'warmup', id }
 *   { type: 'transcribe', id, pcm: Float32Array }
 *
 * child → parent:
 *
 *   { type: 'progress', data }    // hf transformers progress
 *   { type: 'warmup-ok', id }
 *   { type: 'transcribe-ok', id, text }
 *   { type: 'error', id, message }
 */

type Transcriber = (
  audio: Float32Array,
  options?: unknown,
) => Promise<{ text: string } | { text: string }[]>;

const MODEL_NAME = 'Xenova/whisper-small';
const TARGET_SAMPLE_RATE = 16_000;
const TASK = 'transcribe';

let transcriber: Transcriber | null = null;
let loading: Promise<Transcriber> | null = null;

interface WarmupRequest {
  type: 'warmup';
  id: string;
}
interface TranscribeRequest {
  type: 'transcribe';
  id: string;
  pcm: Float32Array;
}
type Request = WarmupRequest | TranscribeRequest;

function send(msg: Record<string, unknown>): void {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

async function load(): Promise<Transcriber> {
  if (transcriber) return transcriber;
  if (loading) return loading;
  loading = (async () => {
    const cacheDir = join(homedir(), '.jarvis', 'models');
    mkdirSync(cacheDir, { recursive: true });
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;
    const p = (await pipeline('automatic-speech-recognition', MODEL_NAME, {
      dtype: 'q8',
      progress_callback: (data: unknown) => {
        send({ type: 'progress', data });
      },
    })) as unknown as Transcriber;
    const inner = p as unknown as {
      model?: { generation_config?: Record<string, unknown> };
    };
    if (inner.model?.generation_config) {
      inner.model.generation_config['task'] = TASK;
      delete inner.model.generation_config['language'];
      delete inner.model.generation_config['forced_decoder_ids'];
    }
    transcriber = p;
    return p;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

async function handle(msg: Request): Promise<void> {
  try {
    if (msg.type === 'warmup') {
      await load();
      send({ type: 'warmup-ok', id: msg.id });
      return;
    }
    if (msg.type === 'transcribe') {
      const w = await load();
      const result = await w(msg.pcm, {
        sampling_rate: TARGET_SAMPLE_RATE,
        chunk_length_s: 30,
        task: TASK,
      } as unknown as Parameters<Transcriber>[1]);
      const text = Array.isArray(result)
        ? result.map((r) => r.text).join(' ')
        : result.text;
      send({ type: 'transcribe-ok', id: msg.id, text: text.trim() });
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
  if (req.type !== 'warmup' && req.type !== 'transcribe') return;
  void handle(req);
});

process.on('uncaughtException', (err) => {
  // Surface so the parent's stderr-passthrough catches it before
  // the process dies. A SIGSEGV from ONNX still won't reach here.
  console.error('[transcribe-worker:uncaught]', err);
});

// Heartbeat log so the parent sees the child came up.
console.log(`[transcribe-worker] ready pid=${process.pid}`);
