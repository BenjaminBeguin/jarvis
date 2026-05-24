import { useRef, useState } from 'react';

import { navigateMobile } from './MobileApp';
import type { MobileAuth } from './types';

interface Props {
  auth: MobileAuth;
}

type Phase =
  | 'idle'
  | 'listening'
  | 'uploading'
  | 'errored';

/**
 * Phone-side dictate. Tap the orb → MediaRecorder captures
 * audio; tap again → POST /v1/audio/dispatch with the raw blob;
 * the Mac transcribes + dispatches via routePrompt and returns
 * a taskId, which we navigate the user to so they can watch the
 * conversation unfold.
 *
 * iOS Safari supports MediaRecorder as of 14.5 — captures audio
 * as MP4/AAC. ffmpeg on the Mac side decodes either MP4 or WebM
 * via the shared decodeAudioToFloat32 helper.
 */
export function MobileDictate({ auth }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const start = async (): Promise<void> => {
    setError(null);
    setPhase('listening');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      });
      rec.addEventListener('stop', () => {
        void finish(rec.mimeType);
      });
      rec.start();
      recorderRef.current = rec;
    } catch (e) {
      stopStream();
      setError(
        e instanceof Error
          ? `Mic access failed: ${e.message}`
          : 'Mic access failed.',
      );
      setPhase('errored');
    }
  };

  const stop = (): void => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state === 'recording') rec.stop();
    recorderRef.current = null;
    setPhase('uploading');
  };

  const finish = async (mime: string): Promise<void> => {
    stopStream();
    const blob = new Blob(chunksRef.current, {
      type: mime || 'audio/webm',
    });
    chunksRef.current = [];
    if (blob.size === 0) {
      setError("Didn't hear anything.");
      setPhase('errored');
      return;
    }
    try {
      const res = await fetch(`${auth.baseUrl}/v1/audio/dispatch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': blob.type || 'audio/webm',
        },
        body: blob,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { taskId: string; text?: string };
      navigateMobile('conversation', { id: data.taskId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('errored');
    }
  };

  const stopStream = (): void => {
    const s = streamRef.current;
    if (s) {
      for (const track of s.getTracks()) track.stop();
    }
    streamRef.current = null;
  };

  const onTap = (): void => {
    if (phase === 'listening') {
      stop();
    } else if (phase === 'idle' || phase === 'errored') {
      void start();
    }
  };

  const label =
    phase === 'idle'
      ? 'Tap to dictate'
      : phase === 'listening'
        ? 'Listening — tap to send'
        : phase === 'uploading'
          ? 'Transcribing…'
          : 'Try again';

  return (
    <div className="mobile-dictate">
      <button
        type="button"
        className={`mobile-dictate__orb mobile-dictate__orb--${phase}`}
        onClick={onTap}
        disabled={phase === 'uploading'}
        aria-label={label}
      >
        <span className="mobile-dictate__glyph" aria-hidden>
          ◢
        </span>
      </button>
      <div className="mobile-dictate__label">{label}</div>
      {error && <div className="mobile-dictate__error">{error}</div>}
      <div className="mobile-dictate__hint">
        Audio is decoded + transcribed on your Mac (local Whisper) and
        dispatched as a voice prompt.
      </div>
    </div>
  );
}

/** Pick the best MediaRecorder mime type the browser supports.
 *  iOS Safari prefers audio/mp4; Chrome/Android prefer audio/webm.
 *  Returning empty string falls back to the browser default. */
function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}
