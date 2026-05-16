import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

import { transcribePcm } from '../../transcribe.js';

const TARGET_SAMPLE_RATE = 16_000;

/**
 * Decode a Telegram voice note (OGG Opus) to 16kHz mono PCM, then run
 * Whisper on it. Returns the transcribed text.
 *
 * Telegram voice notes are always 48kHz OGG/Opus; we resample down to
 * Whisper's required 16kHz with one ffmpeg invocation: `-ar 16000 -ac 1
 * -f f32le -` outputs raw Float32 PCM on stdout, which we collect into
 * a Float32Array and feed straight to `transcribePcm`.
 */
export async function transcribeOgg(oggBuffer: Buffer): Promise<string> {
  const pcm = await decodeOggToFloat32(oggBuffer);
  return transcribePcm(pcm);
}

function decodeOggToFloat32(oggBuffer: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static binary not available on this platform'));
      return;
    }
    const proc = spawn(ffmpegPath, [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ar', String(TARGET_SAMPLE_RATE),
      '-ac', '1',
      '-f', 'f32le',
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
      // f32le = 4 bytes per sample, little-endian. Build a Float32Array
      // view over the buffer's underlying ArrayBuffer slice.
      const arrayBuffer = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      );
      resolve(new Float32Array(arrayBuffer));
    });

    proc.stdin.write(oggBuffer);
    proc.stdin.end();
  });
}
