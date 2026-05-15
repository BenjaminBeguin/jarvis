import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { InboxItem } from '@shared/types';

/**
 * Ad-hoc meeting detector.
 *
 * Streams macOS unified-log events for Core Audio / CMIO subsystems and
 * fires a callback the first time the system's microphone (or camera)
 * goes from idle → in-use after the watcher starts. This is the same
 * signal that drives the orange/green indicator in the menu bar — works
 * for any app: Google Meet, Zoom, Discord, FaceTime, Photo Booth, etc.
 *
 * Why this approach: per-tab mic state isn't exposed by Chrome to
 * outside processes (would need a browser extension), but
 * `log stream --style ndjson --predicate '...'` gives us a real
 * event stream from macOS itself. No polling, no AppleScript, no
 * permissions beyond what the user has already granted Jarvis.
 *
 * Tradeoffs:
 *   - macOS-only. On other platforms the watcher is a no-op.
 *   - We can't know WHICH app turned the mic on — only that something
 *     did. The toast says "mic active — record this?"; the user makes
 *     the call. False positives (Voice Memos, dictation, GarageBand)
 *     are cheap because the toast auto-dismisses in 90s.
 *   - `log stream` predicates vary slightly by macOS version. The
 *     filter is intentionally broad; JS does the final match. Set
 *     JARVIS_DEBUG_MEETING_LOG=1 to dump matching events to console.
 *
 * TODO (later): for rock-solid detection, ship a small Swift helper
 * that listens to `kAudioDevicePropertyDeviceIsRunningSomewhere` +
 * the CMIO equivalent and writes events to stdout. Same API on this
 * end — just swap how `child` gets spawned.
 */

export interface MeetingActivityCallback {
  (item: InboxItem): void;
}

/**
 * Cooldown after a prompt. Without this, a user who clicks Skip but
 * stays on the same call would get re-prompted as soon as the next
 * mic toggle (mute / unmute) hits the log. 10 min is enough to span
 * a standup, short enough to re-prompt on a back-to-back meeting.
 */
const PROMPT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Min interval between two state-change events to count as "really
 * went active". Filters out the brief mic blip macOS does to test
 * permission at app launch.
 */
const STABILIZE_MS = 1500;

export class MeetingActivityWatcher {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private buffer = '';
  private micActive = false;
  private cameraActive = false;
  private pendingMicSince = 0;
  private pendingCameraSince = 0;
  private lastPromptAt = 0;
  private suppressed = new Set<string>();
  private debug = false;

  constructor(private prompt: MeetingActivityCallback) {
    this.debug = process.env.JARVIS_DEBUG_MEETING_LOG === '1';
  }

  start(): void {
    if (process.platform !== 'darwin') return;
    if (this.child) return;
    // Broad predicate — we match again in JS for clarity / debuggability.
    // `eventMessage` text varies by macOS version; we include several
    // known phrasings.
    const predicate = [
      '(subsystem == "com.apple.coreaudio"',
      '  OR subsystem == "com.apple.audio.AVAEEngine"',
      '  OR subsystem CONTAINS "cmio"',
      '  OR subsystem CONTAINS "AVFoundation")',
      'AND (eventMessage CONTAINS "Running"',
      '  OR eventMessage CONTAINS "RunningSomewhere"',
      '  OR eventMessage CONTAINS "Recording"',
      '  OR eventMessage CONTAINS "started"',
      '  OR eventMessage CONTAINS "stopped"',
      '  OR eventMessage CONTAINS "isAvailable")',
    ].join(' ');
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        '/usr/bin/log',
        ['stream', '--style', 'ndjson', '--predicate', predicate],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      console.warn('MeetingActivityWatcher: spawn failed', err);
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onChunk(chunk));
    child.on('error', (err) => {
      console.warn('MeetingActivityWatcher: stream error', err);
    });
    child.on('exit', (code) => {
      if (code != null && code !== 0) {
        console.warn(`MeetingActivityWatcher: log stream exited (${code})`);
      }
      this.child = null;
    });
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

  /** Renderer Skip → suppress until the next session cooldown elapses. */
  suppress(id: string): void {
    this.suppressed.add(id);
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('[')) continue; // ndjson preamble / closing
      try {
        const evt = JSON.parse(line) as {
          eventMessage?: string;
          subsystem?: string;
        };
        this.handleEvent(evt);
      } catch {
        // log stream emits a single non-JSON line at start; ignore.
      }
    }
  }

  private handleEvent(evt: {
    eventMessage?: string;
    subsystem?: string;
  }): void {
    const msg = evt.eventMessage ?? '';
    const sub = evt.subsystem ?? '';
    if (!msg) return;
    if (this.debug) {
      console.log(`[meeting-activity] ${sub}: ${msg.slice(0, 160)}`);
    }
    const lower = msg.toLowerCase();
    const isCamera = sub.includes('cmio') || lower.includes('camera');
    const isAudio =
      sub === 'com.apple.coreaudio' || sub === 'com.apple.audio.avaeengine';
    // "device went hot" tokens vary; these three cover most variants.
    const wentActive =
      /runningsomewhere.*=.*1|recording is in progress|started running|deviceisrunning.*=.*1|isavailable.*=.*1/i.test(
        msg,
      );
    const wentIdle =
      /runningsomewhere.*=.*0|recording stopped|stopped running|deviceisrunning.*=.*0|isavailable.*=.*0/i.test(
        msg,
      );
    const now = Date.now();
    if (isAudio && wentActive) {
      if (now - this.pendingMicSince < STABILIZE_MS) return;
      this.pendingMicSince = now;
      if (!this.micActive) {
        this.micActive = true;
        this.maybePrompt('mic');
      }
    } else if (isAudio && wentIdle) {
      this.micActive = false;
    } else if (isCamera && wentActive) {
      if (now - this.pendingCameraSince < STABILIZE_MS) return;
      this.pendingCameraSince = now;
      if (!this.cameraActive) {
        this.cameraActive = true;
        this.maybePrompt('camera');
      }
    } else if (isCamera && wentIdle) {
      this.cameraActive = false;
    }
  }

  private maybePrompt(kind: 'mic' | 'camera'): void {
    const now = Date.now();
    if (now - this.lastPromptAt < PROMPT_COOLDOWN_MS) return;
    // Synthetic id: one per "session" of activity, salted by kind so a
    // back-to-back mic-then-camera doesn't double-prompt the same call.
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
    try {
      this.prompt(item);
    } catch (err) {
      console.warn('MeetingActivityWatcher: prompt callback threw', err);
    }
  }
}
