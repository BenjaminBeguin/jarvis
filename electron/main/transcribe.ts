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

const MODEL_NAME = 'Xenova/whisper-tiny.en';
const TARGET_SAMPLE_RATE = 16_000;

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
  const result = await w(pcm, {
    sampling_rate: TARGET_SAMPLE_RATE,
    chunk_length_s: 30,
    language: 'en',
  });
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
