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
const MODEL_NAME = 'Xenova/whisper-tiny';
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
    // Dynamic import keeps transformers.js out of cold-startup. It's a heavy
    // package and we don't need to pay the cost until the user first holds
    // the mic.
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;

    const seenFiles = new Set<string>();
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
    // Pre-set task='transcribe' on the model so the pipeline doesn't try
    // to translate. Language is intentionally left UNSET — the multilingual
    // model auto-detects per chunk, which is what we want for meetings
    // that mix languages (English / French / etc.). If a chunk has no
    // language signal (silence, noise), Whisper falls back gracefully and
    // our cleanChunkText filter drops the typical hallucinations.
    const inner = p as unknown as {
      model?: { generation_config?: Record<string, unknown> };
    };
    if (inner.model?.generation_config) {
      inner.model.generation_config['task'] = TASK;
      // Explicitly clear any stale language default the model card may
      // have shipped with, so detection actually runs.
      delete inner.model.generation_config['language'];
      delete inner.model.generation_config['forced_decoder_ids'];
    }
    emitProgress({ status: 'ready' });
    transcriber = p;
    return p;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

export async function transcribePcm(pcm: Float32Array): Promise<string> {
  emitProgress({ status: 'transcribing' });
  const w = await load();
  // Whisper expects 16kHz mono PCM as a Float32Array. The renderer is
  // already resampling, but the pipeline doesn't enforce — caller's responsibility.
  // No `language` here — Whisper auto-detects per call. `task: transcribe`
  // is still passed explicitly because some transformers.js versions need
  // it on the call options even when set in generation_config.
  const result = await w(pcm, {
    sampling_rate: TARGET_SAMPLE_RATE,
    chunk_length_s: 30,
    task: TASK,
  } as unknown as Parameters<Transcriber>[1]);
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
