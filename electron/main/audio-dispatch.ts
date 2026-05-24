import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

/**
 * Generic "audio blob from anywhere → 16kHz mono Float32 PCM"
 * helper. Used by the mobile PWA's POST /v1/audio/dispatch (WebM/
 * Opus from iOS MediaRecorder) but works for any container
 * ffmpeg can decode. Telegram OGG voice notes still go through
 * the dedicated transcribeOgg path to keep that module's wiring
 * intact.
 */

const TARGET_SAMPLE_RATE = 16_000;

export function decodeAudioToFloat32(buffer: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static binary not available on this platform'));
      return;
    }
    const proc = spawn(ffmpegPath, [
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-ar',
      String(TARGET_SAMPLE_RATE),
      '-ac',
      '1',
      '-f',
      'f32le',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      const raw = Buffer.concat(chunks);
      const arrayBuffer = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      );
      resolve(new Float32Array(arrayBuffer));
    });

    proc.stdin.write(buffer);
    proc.stdin.end();
  });
}
