import { useEffect, useRef, useState } from 'react';

import { AudioCapture } from '../voice/AudioCapture';

/**
 * Floating "Jarvis is listening" orb. Triggered by ⌘⇧Space:
 *
 *   1. First press: open orb + start mic. Pulsing cyan circle +
 *      "Listening…" label.
 *   2. Second press (or click the orb): stop mic, transcribe via
 *      Whisper, dispatch via routePrompt as a 'voice' origin task.
 *   3. Esc: cancel without dispatching.
 *
 * Replaces the full palette UI for the voice flow — a small orb
 * is less disruptive than slamming the palette in your face.
 */

type Phase =
  | 'idle'        // mounted but not listening yet
  | 'listening'   // mic open, capturing audio
  | 'transcribing' // PCM → Whisper round-trip
  | 'dispatching'  // routePrompt running
  | 'done'        // dispatched, about to close
  | 'cancelled'   // Esc — about to close
  | 'errored';

export function VoiceOrb() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  /** Animated mic level (0..1). Drives the orb's outer ring scale
   *  so the visualization feels alive while you talk. */
  const [level, setLevel] = useState(0);
  const captureRef = useRef<AudioCapture | null>(null);
  const levelTimerRef = useRef<number | null>(null);

  // Receive the shortcut toggle. The first press is what brought
  // the window up — start listening. The next press stops.
  useEffect(() => {
    const off = window.jarvis.onVoiceOrbToggle(() => {
      if (phase === 'idle') void start();
      else if (phase === 'listening') void stopAndDispatch();
      // ignore toggles while transcribing/dispatching
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    // Auto-start on first mount — the shortcut handler races with
    // the renderer ready-to-show, so we won't always get the
    // initial toggle. Kicking off here means the user doesn't
    // need a second press just because the window was cold.
    if (phase === 'idle') {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void cancel();
      } else if (e.key === 'Enter') {
        if (phase === 'listening') {
          void stopAndDispatch();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /** Poll the recorder's level on a small interval so the orb's
   *  outer ring breathes with the user's voice. AudioCapture
   *  doesn't expose a level meter; approximate via capturedSamples
   *  delta over a 60ms window. */
  useEffect(() => {
    if (phase !== 'listening') {
      setLevel(0);
      if (levelTimerRef.current != null) {
        window.clearInterval(levelTimerRef.current);
        levelTimerRef.current = null;
      }
      return;
    }
    let prevSamples = captureRef.current?.capturedSamples() ?? 0;
    levelTimerRef.current = window.setInterval(() => {
      const cap = captureRef.current;
      if (!cap) return;
      const samples = cap.capturedSamples();
      const delta = samples - prevSamples;
      prevSamples = samples;
      // delta is ≈sourceSampleRate * intervalSec when speaking
      // hard, 0 when silent. Normalize against a heuristic max.
      const sr = cap.sampleRate() ?? 48000;
      const normalised = Math.min(1, delta / (sr * 0.06));
      setLevel((prev) => prev * 0.6 + normalised * 0.4);
    }, 60);
    return () => {
      if (levelTimerRef.current != null) {
        window.clearInterval(levelTimerRef.current);
        levelTimerRef.current = null;
      }
    };
  }, [phase]);

  const start = async (): Promise<void> => {
    setError(null);
    setTranscript('');
    try {
      const perm = await window.jarvis.requestMicAccess();
      if (!perm.granted) {
        setError(
          perm.status === 'denied'
            ? 'Mic denied. Enable in System Settings → Privacy → Microphone.'
            : `Mic unavailable (${perm.status})`,
        );
        setPhase('errored');
        return;
      }
    } catch {
      // permission probe failed; fall through to capture which
      // gives a clearer error
    }
    // Suppress meeting-recorder BEFORE opening the mic — otherwise
    // coreaudiod's first "Input/Capture" log line wins the race
    // and prompts the user to record their own dictation.
    await window.jarvis.noteSelfMicStart();
    const capture = new AudioCapture();
    try {
      await capture.start();
    } catch (e) {
      void window.jarvis.noteSelfMicStop();
      setError(`Mic open failed: ${e instanceof Error ? e.message : String(e)}`);
      setPhase('errored');
      return;
    }
    captureRef.current = capture;
    setPhase('listening');
  };

  const stopAndDispatch = async (): Promise<void> => {
    const capture = captureRef.current;
    if (!capture) {
      void closeSoon();
      return;
    }
    captureRef.current = null;
    setPhase('transcribing');
    void window.jarvis.noteSelfMicStop();
    let result;
    try {
      result = await capture.stop();
    } catch (e) {
      setError(`Capture failed: ${e instanceof Error ? e.message : String(e)}`);
      setPhase('errored');
      return;
    }
    if (result.pcm.length < 16_000 * 0.3) {
      setError("Didn't hear anything — try again.");
      setPhase('errored');
      return;
    }
    let text: string;
    try {
      text = (
        await window.jarvis.transcribe(result.pcm.buffer as ArrayBuffer)
      ).trim();
    } catch (e) {
      setError(
        `Transcribe failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      setPhase('errored');
      return;
    }
    if (!text) {
      setError("Couldn't make out the audio.");
      setPhase('errored');
      return;
    }
    setTranscript(text);
    setPhase('dispatching');
    try {
      await window.jarvis.routePrompt(text, { origin: 'voice' });
    } catch (e) {
      setError(
        `Dispatch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      setPhase('errored');
      return;
    }
    setPhase('done');
    void closeSoon(900);
  };

  const cancel = async (): Promise<void> => {
    if (captureRef.current) {
      try {
        await captureRef.current.stop();
      } catch {
        /* ignore */
      }
      captureRef.current = null;
      void window.jarvis.noteSelfMicStop();
    }
    setPhase('cancelled');
    void closeSoon(220);
  };

  const closeSoon = async (delay = 320): Promise<void> => {
    await new Promise((r) => window.setTimeout(r, delay));
    await window.jarvis.hideVoiceOrb();
  };

  const label =
    phase === 'idle'
      ? 'Preparing…'
      : phase === 'listening'
        ? 'Listening…'
        : phase === 'transcribing'
          ? 'Transcribing…'
          : phase === 'dispatching'
            ? 'Dispatching…'
            : phase === 'done'
              ? 'Sent.'
              : phase === 'cancelled'
                ? 'Cancelled.'
                : 'Error.';

  return (
    <div
      className={`voice-orb voice-orb--${phase}`}
      onClick={() => {
        if (phase === 'listening') void stopAndDispatch();
      }}
      role="button"
      tabIndex={0}
      aria-label={label}
    >
      <div
        className="voice-orb__ring voice-orb__ring--outer"
        style={{ transform: `scale(${1 + level * 0.35})` }}
      />
      <div
        className="voice-orb__ring voice-orb__ring--mid"
        style={{ transform: `scale(${1 + level * 0.2})` }}
      />
      <div className="voice-orb__core">
        <div className="voice-orb__glyph" aria-hidden>
          ◢
        </div>
      </div>
      <div className="voice-orb__label">{label}</div>
      {transcript && phase !== 'listening' && (
        <div className="voice-orb__transcript">"{transcript}"</div>
      )}
      {error && <div className="voice-orb__error">{error}</div>}
      <div className="voice-orb__hint">
        {phase === 'listening'
          ? '⌘⇧Space or click to send · Esc to cancel'
          : phase === 'errored'
            ? 'Esc to dismiss'
            : null}
      </div>
    </div>
  );
}
