import { speak, stopSpeaking } from './speech.js';
import { warmUp as warmUpTranscribe } from './transcribe.js';
import type { Module } from '../types.js';

/**
 * Voice module — owns Jarvis's audio infrastructure:
 *
 *   - Whisper transcription, isolated in a forked child process
 *     (see ./transcribe.ts + ./transcribe-worker.ts). ONNX
 *     Runtime can SIGSEGV on certain models; the fork boundary
 *     keeps a crash from taking the whole app down.
 *   - macOS `say`-based TTS for reading assistant replies aloud
 *     (see ./speech.ts).
 *
 * The module itself is intentionally thin — the heavy lifting
 * lives in the sibling files. What this file adds:
 *
 *   - Lifecycle: onLoad pre-warms the Whisper worker so the first
 *     ⌘⇧Space dictation isn't paying spawn + model-load latency.
 *     onUnload cuts any in-flight TTS utterance.
 *   - Palette intents: /speak <text> for quick TTS test or
 *     hands-free read-back of arbitrary text.
 *
 * Consumers (the voice-orb window, the conversation composer mic,
 * the meeting recorder) reach the audio helpers via direct import
 * from ./transcribe.js and ./speech.js — same files as before,
 * just moved here. IPC handlers stay in electron/main/ipc/media.ts.
 */
export const voiceModule: Module = {
  id: 'voice',
  name: 'Voice',
  description:
    'Local Whisper transcription (forked worker, crash-isolated) + macOS say TTS for dictation and read-back.',
  version: '1.0.0',
  memory: [
    {
      label: 'Whisper model cache',
      location: '~/.jarvis/models/',
      kind: 'directory',
      access: 'read-write',
      notes:
        'ONNX-quantised whisper-base lazily downloaded by Transformers.js on first dictation. ~150 MB. Safe to delete; will re-download.',
    },
  ],
  intents: [
    {
      id: 'speak',
      prefix: '/speak',
      label: 'Speak text aloud',
      description: 'Read the rest of the prompt aloud via system TTS',
      placeholder: 'Text to say…',
      handler: (input, ctx) => {
        const text = input.trim();
        if (!text) return 'Pass some text after /speak.';
        void speak(text);
        ctx.logActivity({
          kind: 'voice.spoken',
          label: `Spoke · "${text.length > 60 ? text.slice(0, 59) + '…' : text}"`,
          detail: { length: text.length },
        });
        const preview = text.length > 40 ? text.slice(0, 39) + '…' : text;
        return `Speaking · "${preview}"`;
      },
    },
    {
      id: 'shush',
      prefix: '/shush',
      label: 'Stop speaking',
      description:
        'Interrupt the current TTS utterance. Useful when the voice-loop reply runs longer than you want to hear.',
      verbalTriggers: [
        'shush',
        'stop talking',
        'stop speaking',
        'quiet',
        'shut up',
      ],
      handler: () => {
        stopSpeaking();
        return 'Shushed.';
      },
    },
  ],
  onLoad: () => {
    // Fire-and-forget warmup so the first dictation skips the
    // spawn + load tax. Delayed so we don't fight the rest of
    // cold-startup for CPU.
    setTimeout(() => {
      void warmUpTranscribe();
    }, 2_000);
  },
  onUnload: () => {
    stopSpeaking();
    // The transcribe worker stays alive across module reloads —
    // it's reasonably cheap to keep, and the main-process side
    // doesn't currently expose a shutdown hook. Worth adding if
    // we ever support disabling the voice module to reclaim
    // memory, but not load-bearing today.
  },
};
