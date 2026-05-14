import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { transcribePcm } from '../transcribe.js';
import type { Module } from './types.js';

const CHANNEL_START = 'meeting:start';
const CHANNEL_STOP_REQUEST = 'meeting:stop-request';

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'meeting'
  );
}

function timestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}`
  );
}

export const meetingRecorderModule: Module = {
  id: 'meeting-recorder',
  name: 'Meeting recorder',
  description:
    'Record a meeting, transcribe locally via Whisper, save as a markdown transcript you can push to Claude',
  version: '1.0.0',
  intents: [
    {
      id: 'start',
      prefix: '/meeting',
      label: 'Record meeting',
      description: 'Start capturing audio — stop button appears top-right',
      placeholder: 'Meeting title (optional)',
      verbalTriggers: [
        'record the meeting',
        'record this meeting',
        'record meeting',
        'start the meeting',
        'start meeting',
        'start recording',
        'begin recording',
        'capture this meeting',
        'capture meeting',
      ],
      handler: (input, ctx) => {
        const title =
          input.trim() ||
          `Meeting at ${new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}`;
        ctx.broadcast(CHANNEL_START, { title, startedAt: Date.now() });
        return `Recording started · ${title}`;
      },
    },
    {
      id: 'stop',
      prefix: '/meeting-stop',
      label: 'Stop meeting recording',
      description: 'Stop the current recording and transcribe',
      verbalTriggers: [
        'stop the meeting',
        'stop meeting',
        'stop recording',
        'end recording',
        'end the meeting',
      ],
      handler: (_input, ctx) => {
        ctx.broadcast(CHANNEL_STOP_REQUEST);
        return 'Stop requested';
      },
    },
  ],
};

interface FinishedRecording {
  title: string;
  startedAt: number;
  endedAt: number;
  pcm: Float32Array;
  /** Sample rate of the PCM (almost always 16_000). */
  sampleRate: number;
}

/**
 * Transcribe the recorded audio and persist a meeting markdown file.
 * Returns the relative path under ~/.jarvis/meetings/ so the caller can
 * surface a notification with a clickable file path.
 */
export async function persistMeeting(
  jarvisRoot: string,
  recording: FinishedRecording,
): Promise<string> {
  const transcript = await transcribePcm(recording.pcm);
  const durationSec = Math.round(
    (recording.endedAt - recording.startedAt) / 1000,
  );
  const dir = join(jarvisRoot, 'meetings');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = `${timestamp(new Date(recording.startedAt))}-${slugify(recording.title)}.md`;
  const filePath = join(dir, filename);
  const startedAtIso = new Date(recording.startedAt).toISOString();
  const body =
    `---\n` +
    `title: ${recording.title}\n` +
    `started_at: ${startedAtIso}\n` +
    `duration_seconds: ${durationSec}\n` +
    `---\n\n` +
    `# ${recording.title}\n\n` +
    `${transcript || '_no speech detected_'}\n`;
  writeFileSync(filePath, body, 'utf8');
  return filename;
}
