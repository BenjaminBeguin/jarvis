import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TranscribeProgress } from '@shared/types';

/**
 * Speech-to-text via @huggingface/transformers running Whisper (Xenova/
 * whisper-tiny.en) on ONNX Runtime. Pure JS / N-API — no native compilation
 * pain. The model auto-downloads on first use (~75MB) and caches under
 * ~/.jarvis/models/.
 *
 * Web Speech API in Electron is unusable upstream (Google service auth);
 * this is the proper offline replacement.
 */

type Transcriber = (audio: Float32Array, options?: unknown) => Promise<{ text: string } | { text: string }[]>;

// Multilingual whisper-tiny (not .en). Same architecture, same size on disk
// (~75MB), but accepts `language` / `task` arguments — which lets us sidestep
// the transformers.js bug where English-only models throw if either is set,
// even transitively via the loaded model's generation_config defaults.
// Language is left UNSET so Whisper auto-detects per audio chunk. Task is
// always 'transcribe' (never 'translate') so output stays in the spoken
// language rather than being force-translated to English.
// whisper-small (~466MB, q8 quantized): meaningful quality jump over tiny,
// especially for accented English / French / mixed-language meetings. First
// run downloads + caches under ~/.jarvis/models/; subsequent loads are fast.
const MODEL_NAME = 'Xenova/whisper-small';
const TARGET_SAMPLE_RATE = 16_000;
const TASK = 'transcribe';

let transcriber: Transcriber | null = null;
let loading: Promise<Transcriber> | null = null;
let emitProgress: (event: TranscribeProgress) => void = () => {};

export function setProgressEmitter(fn: (event: TranscribeProgress) => void): void {
  emitProgress = fn;
}

async function load(): Promise<Transcriber> {
  if (transcriber) return transcriber;
  if (loading) return loading;
  loading = (async () => {
    const cacheDir = join(homedir(), '.jarvis', 'models');
    mkdirSync(cacheDir, { recursive: true });
    console.log('[transcribe] load: importing @huggingface/transformers');
    const { pipeline, env } = await import('@huggingface/transformers');
    console.log('[transcribe] load: import done');
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;

    const seenFiles = new Set<string>();
    console.log(`[transcribe] load: creating pipeline (${MODEL_NAME}, q8)`);
    const p = (await pipeline('automatic-speech-recognition', MODEL_NAME, {
      dtype: 'q8',
      progress_callback: (data: unknown) => {
        const d = data as {
          status?: string;
          file?: string;
          progress?: number;
          loaded?: number;
          total?: number;
          name?: string;
        };
        if (d.status === 'download' || d.status === 'progress') {
          if (d.file) seenFiles.add(d.file);
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
      },
    })) as unknown as Transcriber;
    console.log('[transcribe] load: pipeline ready');
    const inner = p as unknown as {
      model?: { generation_config?: Record<string, unknown> };
    };
    if (inner.model?.generation_config) {
      inner.model.generation_config['task'] = TASK;
      delete inner.model.generation_config['language'];
      delete inner.model.generation_config['forced_decoder_ids'];
    }
    emitProgress({ status: 'ready' });
    transcriber = p;
    return p;
  })().catch((err) => {
    loading = null;
    console.error('[transcribe] load failed', err);
    throw err;
  });
  return loading;
}

export async function transcribePcm(pcm: Float32Array): Promise<string> {
  console.log(
    `[transcribe] pcm received samples=${pcm.length} (~${(pcm.length / 16000).toFixed(1)}s)`,
  );
  emitProgress({ status: 'transcribing' });
  const w = await load();
  console.log('[transcribe] running inference…');
  let result: { text: string } | { text: string }[];
  try {
    result = await w(pcm, {
      sampling_rate: TARGET_SAMPLE_RATE,
      chunk_length_s: 30,
      task: TASK,
    } as unknown as Parameters<Transcriber>[1]);
  } catch (err) {
    console.error('[transcribe] inference threw', err);
    emitProgress({ status: 'done' });
    throw err;
  }
  console.log('[transcribe] inference done');
  emitProgress({ status: 'done' });
  const text = Array.isArray(result)
    ? result.map((r) => r.text).join(' ')
    : result.text;
  return text.trim();
}

/**
 * Trigger the model load eagerly so the first transcription doesn't double
 * as a 30s download. Safe to call multiple times — load() is idempotent.
 */
export async function warmUp(): Promise<void> {
  await load();
}
