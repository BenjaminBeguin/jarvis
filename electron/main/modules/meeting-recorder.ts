import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { transcribePcm } from './voice/transcribe.js';
import type { Module, ModuleContext } from './types.js';

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

export const MEETING_RECORDER_MODULE_ID = 'meeting-recorder';

export const meetingRecorderModule: Module = {
  id: MEETING_RECORDER_MODULE_ID,
  name: 'Meeting recorder',
  description:
    'Record a meeting, transcribe locally via Whisper, save as a markdown transcript you can push to Claude',
  version: '1.0.0',
  settings: {
    description:
      'When auto-debrief is on (default), every finished meeting runs the meeting-debrief skill in the background — restructures the transcript with Summary / Decisions / Action items sections. Turn off if you want raw transcripts only.',
    fields: [
      {
        key: 'autoDebrief',
        label: 'Auto-debrief on finish',
        hint: 'Run the meeting-debrief skill automatically after each Finish to extract action items.',
        type: 'boolean',
        default: true,
      },
    ],
  },
  memory: [
    {
      label: 'Meeting transcripts (global)',
      location: '~/.jarvis/meetings/<ts>-<slug>.md',
      kind: 'file',
      access: 'write',
      notes:
        'Markdown transcript + auto-debrief. One file per recorded meeting; never overwritten.',
    },
    {
      label: 'Meeting transcripts (per-project)',
      location: '~/.jarvis/meetings/<project-slug>/<ts>-<slug>.md',
      kind: 'file',
      access: 'write',
      notes:
        'When a project scope is set at /meeting time, the transcript files under that project instead of the global folder.',
    },
  ],
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
        // Optional project scoping: "<alias>: <title>" lands the recorded
        // markdown under ~/.jarvis/meetings/<project>/. If <alias> doesn't
        // resolve, treat the whole input as a literal title.
        let project: string | null = null;
        let rawTitle = input.trim();
        const m = /^([\w-]+)\s*:\s*(.+)$/s.exec(rawTitle);
        if (m) {
          const candidate = m[1]!;
          const p = ctx.resolveProject(candidate);
          if (p) {
            project = p.name;
            rawTitle = m[2]!.trim();
          }
        }
        const title =
          rawTitle ||
          currentCalendarEventTitle(ctx) ||
          `Meeting at ${new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}`;
        ctx.broadcast(CHANNEL_START, {
          title,
          project,
          startedAt: Date.now(),
        });
        ctx.logActivity({
          kind: 'meeting.started',
          label: project
            ? `Meeting started · ${project} · ${title}`
            : `Meeting started · ${title}`,
          detail: { title, project },
        });
        return `Recording started · ${project ? `${project} · ${title}` : title}`;
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

/**
 * "Is a calendar event happening RIGHT NOW?" Used to default the
 * `/meeting` title from your actual calendar instead of a generic
 * "Meeting at 10:30". Generous window: an event counts as current
 * if it started in the last 10 min OR starts in the next 5 min
 * (people start recording slightly late or early). Picks the
 * soonest-started event when multiple overlap.
 */
function currentCalendarEventTitle(ctx: ModuleContext): string | null {
  try {
    const now = Date.now();
    const events = ctx
      .listInboxItems()
      .filter(
        (i) =>
          i.source === 'calendar' &&
          typeof i.fireAt === 'number' &&
          i.fireAt >= now - 10 * 60_000 &&
          i.fireAt <= now + 5 * 60_000,
      )
      .sort((a, b) => (b.fireAt ?? 0) - (a.fireAt ?? 0));
    return events[0]?.title ?? null;
  } catch {
    // listInboxItems shouldn't throw, but if the inbox isn't ready
    // yet at very first launch we just fall through to the timestamp.
    return null;
  }
}

interface FinishedRecording {
  title: string;
  startedAt: number;
  endedAt: number;
  pcm: Float32Array;
  /** Sample rate of the PCM (almost always 16_000). */
  sampleRate: number;
  /** Project name when the recording was scoped via "<alias>: <title>". */
  project?: string | null;
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
  const dir = recording.project
    ? join(jarvisRoot, 'meetings', slugify(recording.project))
    : join(jarvisRoot, 'meetings');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = `${timestamp(new Date(recording.startedAt))}-${slugify(recording.title)}.md`;
  const filePath = join(dir, filename);
  const startedAtIso = new Date(recording.startedAt).toISOString();
  const projectLine = recording.project ? `project: ${recording.project}\n` : '';
  const body =
    `---\n` +
    `title: ${recording.title}\n` +
    projectLine +
    `started_at: ${startedAtIso}\n` +
    `duration_seconds: ${durationSec}\n` +
    `---\n\n` +
    `# ${recording.title}\n\n` +
    `${transcript || '_no speech detected_'}\n`;
  writeFileSync(filePath, body, 'utf8');
  // Return path relative to ~/.jarvis/meetings/ so the caller can show a
  // useful breadcrumb.
  return recording.project
    ? join(slugify(recording.project), filename)
    : filename;
}
