import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

import type { InboxItem, MeetingDetectionStatus } from '@shared/types';

/**
 * Ad-hoc meeting detector — fires whenever the microphone (or camera)
 * goes from idle → in-use after the watcher starts. Same signal that
 * drives the orange/green indicator in the menu bar; works for any
 * app: Google Meet, Zoom, Discord, FaceTime, Photo Booth, etc.
 *
 * How it works:
 *   - When audio is flowing through Core Audio, `coreaudiod` logs RMS
 *     measurement events that we can parse out of `log stream`. The
 *     historical signal was `RTAID … node=-Input`; newer macOS
 *     versions changed the wording, so we now look for any
 *     coreaudiod info-line containing input-related keywords (Input /
 *     Capture / Record) and treat that as a heartbeat.
 *   - We watch the heartbeat: an Input event after >IDLE_GAP_MS of
 *     silence = "mic just went hot". We treat that as the meeting-start
 *     signal and fire the prompt.
 *   - Camera follows the same pattern via the CMIO subsystem.
 *
 * Why this approach over alternatives:
 *   - Per-tab mic state isn't exposed by Chrome to other processes —
 *     would need a browser extension.
 *   - `log stream` runs without sudo for user-scope events and needs
 *     no special permissions beyond what Jarvis already has.
 *
 * Tradeoffs:
 *   - macOS-only. No-op elsewhere.
 *   - We can't know WHICH app turned the mic on. The toast says "mic
 *     active — record this?" and the user makes the call. False
 *     positives (Voice Memos, dictation, GarageBand) are cheap because
 *     the toast auto-dismisses in 90s.
 *   - On macOS 15 (Sequoia), the coreaudiod info channel got much
 *     quieter — many sessions don't emit heartbeats anymore. The
 *     watcher emits a `status` event so the renderer can show "auto-
 *     detect quiet · use manual record" instead of pretending it's
 *     working. The manual record button is the safety net.
 *
 * TODO (later): swap the `log stream` parse for a tiny Swift helper
 * that listens to `kAudioDevicePropertyDeviceIsRunningSomewhere` +
 * the CMIO equivalent directly. Same API on this end.
 */

export interface MeetingActivityCallback {
  (item: InboxItem): void;
}

/**
 * Cooldown after a prompt. Without this, brief mic toggles (mute /
 * unmute) inside a call would re-fire the prompt.
 */
const PROMPT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Heartbeat gap: an Input event after this long a silence counts as a
 * fresh "mic just went hot" transition. RTAID events fire ~10×/s while
 * audio is live, so anything ≥3s of silence is a clean break.
 */
const IDLE_GAP_MS = 3000;

/**
 * After start(), ignore detections for this long. macOS doesn't replay
 * past logs into a new stream, but the watcher might come up while
 * audio is already mid-stream (e.g. you launch Jarvis during a call).
 * Better to be slightly slow than to nag on every restart.
 */
const STARTUP_GRACE_MS = 4000;

/** When the watcher hasn't seen any matching event for this long after
 *  startup, we mark it "quiet" so the renderer can surface a manual-
 *  record nudge. macOS 15+ frequently produces zero events. */
const QUIET_THRESHOLD_MS = 60_000;

export class MeetingActivityWatcher extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private buffer = '';
  private startedAt = 0;
  private lastInputAt = 0;
  private lastCameraAt = 0;
  private lastPromptAt = 0;
  private suppressed = new Set<string>();
  private debug: boolean;
  private eventsSeen = 0;
  private inputEventsSeen = 0;
  private fault: string | null = null;
  /** True while WE have the mic open (palette voice / composer
   *  mic / meeting recorder). Suppresses the auto-detect prompt
   *  so we don't try to record ourselves. Set via
   *  noteSelfMicStart/Stop — callers pair them around their
   *  capture lifecycle. Reference-counted so overlapping captures
   *  don't drop the flag prematurely. */
  private selfMicCount = 0;
  private get selfMicActive(): boolean {
    return this.selfMicCount > 0;
  }

  constructor(private prompt: MeetingActivityCallback) {
    super();
    this.debug = process.env.JARVIS_DEBUG_MEETING_LOG === '1';
  }

  start(): void {
    if (process.platform !== 'darwin') {
      this.fault = 'macOS only — auto-detect disabled on this platform.';
      this.emitStatus();
      return;
    }
    if (this.child) return;
    // Process-filter + subsystem CONTAINS. coreaudiod owns input/output
    // state. cmio is the camera framework. The wider OR includes both,
    // and we sniff individual lines for input keywords inside
    // handleEvent so the predicate stays cheap.
    const predicate =
      '(process == "coreaudiod" OR subsystem CONTAINS "cmio" OR subsystem CONTAINS "coreaudio")';
    console.log('[meeting-activity] watcher started (mic/cam)');
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        '/usr/bin/log',
        ['stream', '--style', 'ndjson', '--info', '--predicate', predicate],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[meeting-activity] spawn failed:', err);
      this.fault = `log stream spawn failed: ${msg}`;
      this.emitStatus();
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.fault = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onChunk(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed) console.warn('[meeting-activity] log stderr:', trimmed);
    });
    child.on('error', (err) => {
      console.warn('[meeting-activity] stream error', err);
      this.fault = err instanceof Error ? err.message : String(err);
      this.emitStatus();
    });
    child.on('exit', (code, signal) => {
      if ((code != null && code !== 0) || signal) {
        console.warn(
          `[meeting-activity] log stream exited code=${code} signal=${signal}`,
        );
        this.fault = `log stream exited (code=${code} signal=${signal ?? '-'})`;
      }
      this.child = null;
      this.emitStatus();
    });
    this.emitStatus();
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      // already dead
    }
    this.child = null;
    this.buffer = '';
  }

  /** Renderer Skip → suppress until the cooldown elapses. */
  suppress(id: string): void {
    this.suppressed.add(id);
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const raw of lines) {
      let line = raw.trim();
      if (!line) continue;
      // `log stream --style ndjson` is usually one JSON object per line.
      // Some macOS versions wrap output in an array — strip array
      // delimiters / trailing commas to be safe.
      if (line === '[' || line === ']') continue;
      if (line.endsWith(',')) line = line.slice(0, -1);
      let evt: { eventMessage?: string; subsystem?: string; process?: string };
      try {
        evt = JSON.parse(line) as typeof evt;
      } catch {
        // First line of output is usually plain text ("Filtering …").
        continue;
      }
      this.eventsSeen++;
      this.handleEvent(evt);
    }
  }

  private handleEvent(evt: {
    eventMessage?: string;
    subsystem?: string;
    process?: string;
  }): void {
    const msg = evt.eventMessage ?? '';
    if (!msg) return;
    const proc = evt.process ?? '';
    const sub = evt.subsystem ?? '';
    const now = Date.now();

    // ----- mic: any coreaudiod line that smells like an active input
    //       session. Historical signal was `RTAID … node=-Input` but
    //       macOS 15 muted that channel; we now match a broader set
    //       of input-indicator keywords so we still catch sessions
    //       when coreaudiod chooses to log them. Words checked:
    //       node=-Input, Input, Capture, Record, MicrophoneEnable.
    //       case-insensitive so wording tweaks don't bypass us.
    const INPUT_KEYWORDS =
      /node=-Input|\bInput\b|\bCapture\b|\bRecord\b|MicrophoneEnable/i;
    if (proc === 'coreaudiod' && INPUT_KEYWORDS.test(msg)) {
      this.inputEventsSeen++;
      const wasIdle = now - this.lastInputAt > IDLE_GAP_MS;
      this.lastInputAt = now;
      if (this.debug && this.inputEventsSeen <= 3) {
        console.log(
          `[meeting-activity] input event #${this.inputEventsSeen}, wasIdle=${wasIdle}, msg="${msg.slice(0, 120)}"`,
        );
      }
      // Self-suppress: when WE are recording (palette voice
      // shortcut, conversation composer mic, intentional meeting
      // capture), the coreaudiod input events are ours. Don't
      // self-prompt for a meeting on our own mic. The lastInputAt
      // bookkeeping still updates so the status panel reflects
      // the live mic state.
      if (this.selfMicActive) {
        this.emitStatus();
        return;
      }
      if (wasIdle) this.tryFire('mic');
      this.emitStatus();
      return;
    }

    // ----- camera: cmio events. CMIO framework emits a stream of
    //       events while a capture session is active (quiet when
    //       idle). Same heartbeat trick as audio.
    if (sub.includes('cmio') && /(stream|capture|video|frame)/i.test(msg)) {
      const wasIdle = now - this.lastCameraAt > IDLE_GAP_MS;
      this.lastCameraAt = now;
      if (wasIdle) this.tryFire('camera');
      this.emitStatus();
      return;
    }
  }

  /**
   * Snapshot of detection state — used by the renderer to surface
   * "watcher is quiet" vs. "actively seeing audio events." Read-only
   * computed from the internal counters.
   */
  /** Mark the start of a Jarvis-owned mic capture (palette voice,
   *  composer mic, meeting recorder). Suppresses the auto-detect
   *  prompt for the duration. Pair with noteSelfMicStop(). */
  noteSelfMicStart(): void {
    this.selfMicCount++;
  }

  noteSelfMicStop(): void {
    if (this.selfMicCount > 0) this.selfMicCount--;
  }

  status(): MeetingDetectionStatus {
    return {
      running: !!this.child,
      eventsSeen: this.eventsSeen,
      inputEventsSeen: this.inputEventsSeen,
      lastInputAt: this.lastInputAt || null,
      lastCameraAt: this.lastCameraAt || null,
      lastPromptAt: this.lastPromptAt || null,
      startedAt: this.startedAt,
      fault: this.fault,
    };
  }

  /** Has the watcher seen ANY relevant event since start? After
   *  QUIET_THRESHOLD_MS of running with zero input events, treat as
   *  effectively non-functional — the renderer can show a manual-
   *  record nudge instead. */
  isQuiet(): boolean {
    if (!this.child) return false;
    if (this.fault) return true;
    if (this.inputEventsSeen > 0) return false;
    return Date.now() - this.startedAt > QUIET_THRESHOLD_MS;
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  private tryFire(kind: 'mic' | 'camera'): void {
    const now = Date.now();
    if (now - this.startedAt < STARTUP_GRACE_MS) return;
    if (now - this.lastPromptAt < PROMPT_COOLDOWN_MS) return;
    const id = `ad-hoc-${kind}-${Math.floor(now / PROMPT_COOLDOWN_MS)}`;
    if (this.suppressed.has(id)) return;
    this.lastPromptAt = now;
    const item: InboxItem = {
      id,
      source: 'meeting-activity',
      title:
        kind === 'mic'
          ? 'Mic active — record this meeting?'
          : 'Camera active — record this meeting?',
      subtitle: 'Detected by macOS Core Audio. Tap Record to capture audio.',
      createdAt: now,
    };
    console.log(
      `[meeting-activity] firing prompt (kind=${kind}, totalEvents=${this.eventsSeen}, inputEvents=${this.inputEventsSeen})`,
    );
    try {
      this.prompt(item);
    } catch (err) {
      console.warn('[meeting-activity] prompt callback threw', err);
    }
    this.emitStatus();
  }
}
