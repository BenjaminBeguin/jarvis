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

  // Receive the shortcut toggle. The first press brings the
  // window up; we start listening. The next press (while
  // listening) stops + dispatches. After a terminal state
  // ('done', 'errored', 'cancelled') the orb may have been
  // re-shown by the shortcut handler — restart capture fresh.
  // Mid-transcribe / mid-dispatch toggles are ignored.
  useEffect(() => {
    const off = window.jarvis.onVoiceOrbToggle(() => {
      if (
        phase === 'idle' ||
        phase === 'done' ||
        phase === 'errored' ||
        phase === 'cancelled'
      ) {
        void start();
      } else if (phase === 'listening') {
        void stopAndDispatch();
      }
      // transcribing / dispatching — drop the toggle.
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

  /** RMS-based voice activity detection. Two jobs:
   *
   *   1. Drive the orb's level ring so it visibly reacts to your
   *      voice (not just to "samples are flowing" like the
   *      previous heuristic).
   *   2. Auto-stop + dispatch ~1.6s after you finish speaking, so
   *      you don't have to hit ⌘⇧Space twice. Mirrors how every
   *      modern voice assistant behaves.
   */
  const lastSpeechAtRef = useRef(0);
  const sawSpeechRef = useRef(false);
  const lastTickPosRef = useRef(0);
  const startedAtRef = useRef(0);
  const autoStopFiredRef = useRef(false);
  useEffect(() => {
    if (phase !== 'listening') {
      setLevel(0);
      if (levelTimerRef.current != null) {
        window.clearInterval(levelTimerRef.current);
        levelTimerRef.current = null;
      }
      return;
    }
    lastSpeechAtRef.current = 0;
    sawSpeechRef.current = false;
    lastTickPosRef.current = captureRef.current?.capturedSamples() ?? 0;
    startedAtRef.current = Date.now();
    autoStopFiredRef.current = false;

    /** Speech threshold for RMS of 16kHz audio. Whisper-grade
     *  voice usually lands at 0.05+; quiet typing / ambient noise
     *  is around 0.005-0.01. 0.02 is a safe middle. */
    const SPEECH_RMS = 0.02;
    /** Wait this long after the last speech tick before
     *  auto-stopping. Long enough to bridge natural pauses, short
     *  enough not to feel laggy. */
    const SILENCE_TAIL_MS = 1600;
    /** Don't auto-stop if the user hasn't been recording at least
     *  this long — guards against an immediate stop on cold start
     *  before they've begun talking. */
    const MIN_RECORD_MS = 400;

    levelTimerRef.current = window.setInterval(() => {
      const cap = captureRef.current;
      if (!cap) return;
      const now = Date.now();
      const start = lastTickPosRef.current;
      const end = cap.capturedSamples();
      if (end <= start) return;
      lastTickPosRef.current = end;

      const chunk = cap.sliceResampled(start, end);
      if (!chunk || chunk.length === 0) return;

      // RMS of the 16kHz audio window.
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
      const rms = Math.sqrt(sum / chunk.length);

      // Display level — scale RMS so reasonable speech maps to
      // a visible ring (clamped at 1).
      setLevel((prev) => prev * 0.5 + Math.min(1, rms * 6) * 0.5);

      if (rms > SPEECH_RMS) {
        lastSpeechAtRef.current = now;
        sawSpeechRef.current = true;
      }

      // Auto-stop: had speech AND silence has run long enough.
      if (
        sawSpeechRef.current &&
        !autoStopFiredRef.current &&
        now - startedAtRef.current > MIN_RECORD_MS &&
        now - lastSpeechAtRef.current > SILENCE_TAIL_MS
      ) {
        autoStopFiredRef.current = true;
        void stopAndDispatch();
      }
    }, 100);
    return () => {
      if (levelTimerRef.current != null) {
        window.clearInterval(levelTimerRef.current);
        levelTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const startingRef = useRef(false);
  const start = async (): Promise<void> => {
    // Guard against the mount-effect + toggle-event race — both
    // can fire close together when the window is freshly spawned.
    if (startingRef.current || captureRef.current) return;
    startingRef.current = true;
    setError(null);
    setTranscript('');
    setPhase('idle');
    try {
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
        setError(
          `Mic open failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        setPhase('errored');
        return;
      }
      captureRef.current = capture;
      setPhase('listening');
    } finally {
      startingRef.current = false;
    }
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
      // speakReply closes the voice loop: when the agent's result
      // event lands, TaskRunner speaks the final text aloud via
      // macOS `say` (markdown-stripped). User presses orb hotkey,
      // speaks, hears the response. The dispatched task still lives
      // in the conversation view for the full transcript — TTS is
      // additive, not a replacement for the written reply.
      await window.jarvis.routePrompt(text, {
        origin: 'voice',
        sessionConfig: { speakReply: true },
      });
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
          ? 'Stops on its own when you pause · Esc to cancel'
          : phase === 'errored'
            ? 'Esc to dismiss'
            : null}
      </div>
    </div>
  );
}
