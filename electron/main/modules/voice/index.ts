import { loadModuleSettings } from '../../auth.js';
import {
  DEFAULT_RATE,
  DEFAULT_VOICE,
  setSpeechDefaultsProvider,
  speak,
  stopSpeaking,
} from './speech.js';
import { warmUp as warmUpTranscribe } from './transcribe.js';
import type { Module } from '../types.js';

const VOICE_MODULE_ID = 'voice';

/**
 * Voice module — owns Jarvis's audio infrastructure:
 *
 *   - Whisper transcription, isolated in a forked child process
 *     (see ./transcribe.ts + ./transcribe-worker.ts). ONNX
 *     Runtime can SIGSEGV on certain models; the fork boundary
 *     keeps a crash from taking the whole app down.
 *   - macOS `say`-based TTS for reading assistant replies aloud
 *     (see ./speech.ts). Defaults to "Samantha" at 190wpm + light
 *     SSML pauses around sentence boundaries so the playback feels
 *     less robotic. User can pick a different voice + rate via the
 *     settings panel below.
 *
 * The module itself is intentionally thin — the heavy lifting
 * lives in the sibling files. What this file adds:
 *
 *   - Lifecycle: onLoad pre-warms the Whisper worker so the first
 *     ⌘⇧Space dictation isn't paying spawn + model-load latency,
 *     AND wires speech.ts to read TTS prefs live from settings.
 *   - Palette intents: /speak <text> for quick TTS test, /shush to
 *     interrupt an in-flight utterance.
 *
 * Consumers (the voice-orb window, the conversation composer mic,
 * the meeting recorder) reach the audio helpers via direct import
 * from ./transcribe.js and ./speech.js — same files as before,
 * just moved here. IPC handlers stay in electron/main/ipc/media.ts.
 */
export const voiceModule: Module = {
  id: VOICE_MODULE_ID,
  name: 'Voice',
  description:
    'Local Whisper transcription (forked worker, crash-isolated) + macOS say TTS for dictation and read-back.',
  version: '1.0.0',
  settings: {
    description:
      "Default voice + rate for TTS read-back, and the meeting-transcription provider. The Deepgram path uses cloud Nova-3 with speaker diarization — dramatically more reliable than the local Whisper-base on long / quiet audio, with speaker labels in the markdown. Local stays as an offline fallback.",
    fields: [
      {
        key: 'transcribeProvider',
        label: 'Meeting transcription',
        hint: 'Deepgram = cloud Nova-3 with speaker labels (~$0.0043/min, $200 free trial credit on signup). Local = offline Whisper-base — fine for short meetings but prone to looping on silences. Set the Deepgram API key below before switching.',
        type: 'select',
        default: 'local',
        options: [
          { value: 'local', label: 'Local Whisper (offline, no diarization)' },
          { value: 'deepgram', label: 'Deepgram Nova-3 (cloud, speaker labels)' },
        ],
      },
      {
        key: 'deepgramApiKey',
        label: 'Deepgram API key',
        hint: 'Get one at console.deepgram.com — new accounts ship with $200 of credit (~775 hours of audio). Stored in macOS Keychain, never written to disk.',
        type: 'secret',
        default: '',
      },
      {
        key: 'ttsVoice',
        label: 'TTS voice',
        hint: 'Any installed macOS voice name. Run `say -v ? | grep en_` in Terminal to list available ones. Common: Samantha, Daniel, Karen, Ava, Allison.',
        type: 'text',
        default: DEFAULT_VOICE,
      },
      {
        key: 'ttsRate',
        label: 'Speech rate',
        hint: 'Words per minute. macOS default is ~175; 190 feels more conversational. Range: 120–260.',
        type: 'number',
        default: DEFAULT_RATE,
        min: 120,
        max: 260,
        step: 5,
        unit: 'wpm',
      },
    ],
  },
  memory: [
    {
      label: 'Whisper model cache',
      location: '~/.jarvis/models/',
      kind: 'directory',
      access: 'read-write',
      notes:
        'ONNX-quantised whisper-base lazily downloaded by Transformers.js on first dictation. ~150 MB. Safe to delete; will re-download.',
    },
    {
      label: 'TTS voice + rate preferences',
      location: 'config.json · moduleSettings.voice',
      kind: 'config',
      access: 'read',
      notes:
        'Read fresh on every speak() call so changes in Settings take effect without restart. Falls back to Samantha / 190wpm when absent.',
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
    // Re-read settings on every speak() — picks up Settings UI
    // changes without needing a module reload.
    setSpeechDefaultsProvider(() => {
      const cfg = loadModuleSettings(VOICE_MODULE_ID);
      const voice =
        typeof cfg.ttsVoice === 'string' && cfg.ttsVoice.trim()
          ? cfg.ttsVoice.trim()
          : DEFAULT_VOICE;
      const rate =
        typeof cfg.ttsRate === 'number' && cfg.ttsRate > 90
          ? cfg.ttsRate
          : DEFAULT_RATE;
      return { voice, rate };
    });
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
