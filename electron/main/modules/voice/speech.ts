import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Text-to-speech via macOS's built-in `say` command. Local, free,
 * no API setup. Default voice is "Samantha" at a slightly faster
 * rate than system default — sounds noticeably less robotic than
 * the unnamed default. For dramatically better quality the user can
 * install a "Premium" voice in System Settings → Accessibility →
 * Spoken Content → System Voice → Manage Voices, then pick it via
 * the voice module's settings.
 *
 * Single concurrent utterance — `speak()` cancels any in-flight
 * speech first so a new reply doesn't pile on top of the previous
 * one. Long assistant messages get trimmed to keep the cancel-on-
 * reply UX responsive.
 *
 * Emits 'start' (with the spoken text length) and 'stop' on the
 * exported `speechEvents` emitter so other parts of the app — the
 * floating "STOP SPEAKING" pill, the tray menu, the global
 * accelerator — can react to in-flight TTS.
 */

const MAX_SAY_CHARS = 1500;

/** Default voice when the user hasn't overridden. Samantha ships
 *  with macOS and is the most natural of the bundled "standard"
 *  voices for English. The unnamed system default is older +
 *  noticeably more robotic. */
export const DEFAULT_VOICE = 'Samantha';

/** Default rate in words/minute. macOS default is ~175. Bumping to
 *  190 makes Samantha sound more conversational + less plodding
 *  without crossing into chipmunk territory. */
export const DEFAULT_RATE = 190;

let current: ChildProcess | null = null;
let defaultsProvider: () => { voice: string; rate: number } = () => ({
  voice: DEFAULT_VOICE,
  rate: DEFAULT_RATE,
});

/** Fired on every TTS transition so consumers can show / hide a
 *  "stop speaking" affordance without polling `isSpeaking()`. */
export const speechEvents = new EventEmitter();

/** Wire a defaults-reader from the voice module. The fn runs on
 *  EVERY speak() call so config-file edits + Settings UI changes
 *  take effect immediately, without needing a module reload. */
export function setSpeechDefaultsProvider(
  fn: () => { voice: string; rate: number },
): void {
  defaultsProvider = fn;
}

/**
 * Insert small prosody pauses around sentence boundaries so the
 * voice sounds less monotone. `say` honours `[[slnc N]]` inline
 * (N is milliseconds of silence) — a 110ms beat after a period or
 * comma gives the speech room to breathe without dragging.
 *
 * Skipped when the text already contains explicit `[[...]]` directives
 * (advanced users hand-crafting prosody) so we don't double-up.
 */
function humanise(text: string): string {
  if (text.includes('[[')) return text;
  return text
    .replace(/([.!?])\s+/g, '$1 [[slnc 110]] ')
    .replace(/,\s+/g, ', [[slnc 60]] ')
    .replace(/—\s+/g, '— [[slnc 80]] ');
}

/**
 * Speak `text` synchronously-ish via `say`. Returns a promise that
 * resolves when speech finishes (or is cancelled). Idempotent:
 * calling again cancels the previous utterance and starts the new
 * one. Per-call `voice` overrides the module default.
 */
export function speak(text: string, voice?: string): Promise<void> {
  stopSpeaking();
  const trimmed = (text ?? '').trim().slice(0, MAX_SAY_CHARS);
  if (!trimmed) return Promise.resolve();
  const humanised = humanise(trimmed);
  const defaults = defaultsProvider();
  const effectiveVoice = voice ?? defaults.voice;
  const rate =
    defaults.rate > 90 && defaults.rate < 320
      ? Math.round(defaults.rate)
      : DEFAULT_RATE;
  const args: string[] = ['-r', String(rate)];
  if (effectiveVoice) args.push('-v', effectiveVoice);
  args.push(humanised);
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
    speechEvents.emit('start', { length: trimmed.length });
    const finish = (): void => {
      const wasCurrent = current === child;
      if (wasCurrent) {
        current = null;
        speechEvents.emit('stop');
      }
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
  // We zero `current` here AND in the exit handler — whichever runs
  // first emits the 'stop' event, the second is a no-op.
  current = null;
  speechEvents.emit('stop');
}

/** True when an utterance is currently playing. */
export function isSpeaking(): boolean {
  return current !== null && !current.killed;
}
