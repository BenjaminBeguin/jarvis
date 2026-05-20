import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Text-to-speech via macOS's built-in `say` command. Local, free,
 * no API setup. Voice quality is acceptable for short replies;
 * heavier paths (ElevenLabs / OpenAI Voice) can layer on top later
 * if we want a higher-fidelity option.
 *
 * Single concurrent utterance — `speak()` cancels any in-flight
 * speech first so a new reply doesn't pile on top of the previous
 * one. Long assistant messages get trimmed to keep the cancel-on-
 * reply UX responsive.
 */

const MAX_SAY_CHARS = 1500;
let current: ChildProcess | null = null;

/**
 * Speak `text` synchronously-ish via `say`. Returns a promise that
 * resolves when speech finishes (or is cancelled). Idempotent:
 * calling again cancels the previous utterance and starts the new
 * one.
 */
export function speak(text: string, voice?: string): Promise<void> {
  stopSpeaking();
  const trimmed = (text ?? '').trim().slice(0, MAX_SAY_CHARS);
  if (!trimmed) return Promise.resolve();
  const args: string[] = [];
  if (voice) args.push('-v', voice);
  args.push(trimmed);
  return new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('say', args, { stdio: 'ignore' });
    } catch {
      // No `say` on this OS (we assume macOS but be defensive).
      resolve();
      return;
    }
    current = child;
    const finish = (): void => {
      if (current === child) current = null;
      resolve();
    };
    child.on('exit', finish);
    child.on('error', finish);
  });
}

/** Cancel any in-flight speech. Safe to call when nothing is playing. */
export function stopSpeaking(): void {
  if (!current) return;
  try {
    current.kill();
  } catch {
    // Process may have already exited between the check and the kill.
  }
  current = null;
}

/** True when an utterance is currently playing. */
export function isSpeaking(): boolean {
  return current !== null && !current.killed;
}
