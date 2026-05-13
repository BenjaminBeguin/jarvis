import { AudioCapture } from './AudioCapture';

export interface MeetingState {
  active: boolean;
  startedAt: number | null;
  title: string | null;
  /** True while we're transcribing + saving after stop. */
  finishing: boolean;
  error: string | null;
}

const INITIAL_STATE: MeetingState = {
  active: false,
  startedAt: null,
  title: null,
  finishing: false,
  error: null,
};

type Listener = (state: MeetingState) => void;

/**
 * Singleton that holds the active AudioCapture between user clicks and
 * lets any view subscribe to recording state. Lives at module scope so
 * the recording survives navigation between tabs/pages — the user can
 * keep working in Jarvis while the meeting is being captured.
 */
class MeetingRecorder {
  private capture: AudioCapture | null = null;
  private state: MeetingState = { ...INITIAL_STATE };
  private listeners = new Set<Listener>();

  getState(): MeetingState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(title: string): Promise<void> {
    if (this.state.active) return;
    // Make sure the user actually granted mic access first (silent denial
    // would surface as zero samples, very confusing).
    try {
      const perm = await window.jarvis.requestMicAccess();
      if (!perm.granted) {
        this.setState({
          ...this.state,
          error: `Microphone access ${perm.status}`,
        });
        return;
      }
    } catch (err) {
      console.warn('mic permission probe failed', err);
    }
    const capture = new AudioCapture();
    try {
      await capture.start();
    } catch (err) {
      this.setState({
        ...this.state,
        error: `Mic open failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    this.capture = capture;
    this.setState({
      active: true,
      startedAt: Date.now(),
      title,
      finishing: false,
      error: null,
    });
  }

  async stop(): Promise<void> {
    const capture = this.capture;
    if (!this.state.active || !capture) return;
    this.capture = null;
    const title = this.state.title ?? 'Untitled meeting';
    const startedAt = this.state.startedAt ?? Date.now();
    this.setState({ ...this.state, active: false, finishing: true });
    let pcm: Float32Array;
    try {
      const result = await capture.stop();
      pcm = result.pcm;
    } catch (err) {
      this.setState({
        ...INITIAL_STATE,
        error: `Audio capture failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (pcm.length < 16_000) {
      // < 1 second of audio — almost certainly a mistap, skip the round-trip.
      this.setState({
        ...INITIAL_STATE,
        error: 'Recording was too short to transcribe.',
      });
      return;
    }
    try {
      await window.jarvis.meetingFinish({
        title,
        startedAt,
        endedAt: Date.now(),
        sampleRate: 16_000,
        pcm: pcm.buffer as ArrayBuffer,
      });
      this.setState({ ...INITIAL_STATE });
    } catch (err) {
      this.setState({
        ...INITIAL_STATE,
        error:
          err instanceof Error
            ? `Save failed: ${err.message}`
            : 'Save failed',
      });
    }
  }

  abort(): void {
    this.capture?.abort();
    this.capture = null;
    this.setState({ ...INITIAL_STATE });
  }

  private setState(next: MeetingState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}

export const meetingRecorder = new MeetingRecorder();
