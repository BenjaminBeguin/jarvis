import { Notification, ipcMain, systemPreferences } from 'electron';
import { join } from 'node:path';

import { IpcChannels } from '@shared/ipc';

import { loadModuleSettings } from '../auth.js';
import { awaitTurnResult } from '../await-turn.js';
import { pushMeetingActionsToInbox } from '../meeting-actions.js';
import {
  MEETING_RECORDER_MODULE_ID,
  persistMeeting,
} from '../modules/meeting-recorder.js';
import { speak, stopSpeaking } from '../modules/voice/speech.js';
import { transcribePcm } from '../modules/voice/transcribe.js';
import { openObservatory } from '../windows.js';
import type { IpcDeps } from './types.js';

/**
 * Microphone access, audio transcription, and the meeting-finish pipeline
 * (persists the markdown + kicks off the auto-debrief skill).
 */
export function registerMediaIpc({
  runner,
  hud,
  jarvisRoot,
  activity,
  inbox,
}: IpcDeps): void {
  ipcMain.handle(
    IpcChannels.requestMicAccess,
    async (): Promise<{ granted: boolean; status: string }> => {
      if (process.platform !== 'darwin') {
        return { granted: true, status: 'unrestricted' };
      }
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') return { granted: true, status };
      const ok = await systemPreferences.askForMediaAccess('microphone');
      const after = systemPreferences.getMediaAccessStatus('microphone');
      return { granted: ok && after === 'granted', status: after };
    },
  );

  ipcMain.handle(IpcChannels.micStatus, (): { status: string } => {
    const status =
      process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('microphone')
        : 'unrestricted';
    return { status };
  });

  ipcMain.handle(
    IpcChannels.transcribeAudio,
    async (_e, payload: ArrayBuffer): Promise<string> => {
      const pcm = new Float32Array(payload);
      return transcribePcm(pcm);
    },
  );

  ipcMain.handle(
    IpcChannels.speak,
    async (
      _e,
      payload: { text: string; voice?: string },
    ): Promise<{ ok: boolean }> => {
      if (!payload || typeof payload.text !== 'string') return { ok: false };
      await speak(payload.text, payload.voice);
      return { ok: true };
    },
  );

  ipcMain.handle(IpcChannels.stopSpeaking, (): { ok: boolean } => {
    stopSpeaking();
    return { ok: true };
  });

  /** Shared post-persist work: activity row, OS notification, and
   *  auto-debrief launch + action-items extraction. Called from
   *  both the PCM finish path (legacy, short meetings) and the
   *  text finish path (long meetings using live chunks). */
  function afterMeetingPersisted(args: {
    filename: string;
    title: string;
    project: string | null;
    startedAt: number;
    endedAt: number;
  }): void {
    const relPath = `~/.jarvis/meetings/${args.filename}`;
    const durationSec = Math.round((args.endedAt - args.startedAt) / 1000);
    activity.record({
      kind: 'meeting.finished',
      label: args.project
        ? `Meeting saved · ${args.project} · ${args.title} (${formatDuration(durationSec)})`
        : `Meeting saved · ${args.title} (${formatDuration(durationSec)})`,
      detail: {
        title: args.title,
        project: args.project,
        path: relPath,
        durationSec,
      },
    });
    new Notification({ title: 'Meeting saved', body: relPath })
      .on('click', () => openObservatory())
      .show();
    const moduleSettings = loadModuleSettings(MEETING_RECORDER_MODULE_ID);
    const autoDebrief = moduleSettings.autoDebrief !== false;
    if (!autoDebrief) return;
    try {
      const debrief = runner.launch({
        prompt: `Path: ~/.jarvis/meetings/${args.filename}\n\nRead this freshly recorded meeting transcript and restructure the file as the skill instructs.`,
        skillId: 'meeting-debrief',
        origin: 'routine',
      });
      hud.pushTask(debrief.id);
      void (async () => {
        try {
          await awaitTurnResult(runner, debrief.id, {
            timeoutMs: 5 * 60_000,
          });
          const transcriptPath = join(
            jarvisRoot,
            'meetings',
            args.filename,
          );
          pushMeetingActionsToInbox(inbox, {
            transcriptPath,
            meetingTitle: args.title,
            project: args.project,
            finishedAt: args.endedAt,
            meetingKey: args.filename.replace(/\.md$/, ''),
          });
        } catch (err) {
          console.warn(
            '[meeting-actions] extraction after debrief failed:',
            err,
          );
        }
      })();
    } catch (e) {
      console.error('Meeting auto-debrief failed to launch:', e);
    }
  }

  ipcMain.handle(
    IpcChannels.meetingFinish,
    async (
      _e,
      payload: {
        title: string;
        project?: string | null;
        startedAt: number;
        endedAt: number;
        sampleRate: number;
        pcm: ArrayBuffer;
      },
    ): Promise<{ filename: string }> => {
      const filename = await persistMeeting(jarvisRoot, {
        title: payload.title,
        project: payload.project ?? null,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        sampleRate: payload.sampleRate,
        pcm: new Float32Array(payload.pcm),
      });
      afterMeetingPersisted({
        filename,
        title: payload.title,
        project: payload.project ?? null,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
      });
      return { filename };
    },
  );

  /**
   * Long-meeting fast path: renderer hands us already-transcribed
   * text (stitched from the 5-sec live chunks) instead of a giant
   * PCM buffer. Skips the Whisper re-pass entirely — Finish is
   * instant regardless of meeting length, and we avoid marshalling
   * hundreds of MB across IPC.
   */
  ipcMain.handle(
    IpcChannels.meetingFinishFromText,
    async (
      _e,
      payload: {
        title: string;
        project?: string | null;
        startedAt: number;
        endedAt: number;
        transcript: string;
      },
    ): Promise<{ filename: string }> => {
      const filename = await persistMeeting(jarvisRoot, {
        title: payload.title,
        project: payload.project ?? null,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        transcript: payload.transcript,
      });
      afterMeetingPersisted({
        filename,
        title: payload.title,
        project: payload.project ?? null,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
      });
      return { filename };
    },
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
