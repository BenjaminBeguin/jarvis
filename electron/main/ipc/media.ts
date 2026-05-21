import { Notification, ipcMain, systemPreferences } from 'electron';

import { IpcChannels } from '@shared/ipc';

import { persistMeeting } from '../modules/meeting-recorder.js';
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
      const relPath = `~/.jarvis/meetings/${filename}`;
      const durationSec = Math.round((payload.endedAt - payload.startedAt) / 1000);
      activity.record({
        kind: 'meeting.finished',
        label: payload.project
          ? `Meeting saved · ${payload.project} · ${payload.title} (${formatDuration(durationSec)})`
          : `Meeting saved · ${payload.title} (${formatDuration(durationSec)})`,
        detail: {
          title: payload.title,
          project: payload.project,
          path: relPath,
          durationSec,
        },
      });
      new Notification({ title: 'Meeting saved', body: relPath })
        .on('click', () => openObservatory())
        .show();
      // Auto-debrief: kick off the meeting-debrief skill to rewrite the
      // transcript file with Summary / Decisions / Action items sections.
      try {
        const debrief = runner.launch({
          prompt: `Path: ~/.jarvis/meetings/${filename}\n\nRead this freshly recorded meeting transcript and restructure the file as the skill instructs.`,
          skillId: 'meeting-debrief',
          origin: 'routine',
        });
        hud.pushTask(debrief.id);
      } catch (e) {
        console.error('Meeting auto-debrief failed to launch:', e);
      }
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
