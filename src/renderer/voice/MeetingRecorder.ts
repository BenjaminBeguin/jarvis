import { AudioCapture } from './AudioCapture';

export interface LiveTranscriptChunk {
  /** Local id so the renderer can key + dedupe. */
  id: number;
  /** ms since meeting start when this chunk began. */
  offsetMs: number;
  /** Cleaned Whisper output for the chunk. May be empty if filtered. */
  text: string;
}

export interface MeetingState {
  active: boolean;
  startedAt: number | null;
  title: string | null;
  /** Project name when the recording was scoped via "<alias>: <title>". */
  project: string | null;
  /** True while we're transcribing + saving after stop. */
  finishing: boolean;
  error: string | null;
  /** Rolling Whisper chunks transcribed during the recording. */
  liveChunks: LiveTranscriptChunk[];
  /** True while a chunk is currently being transcribed (small spinner). */
  transcribing: boolean;
}

const INITIAL_STATE: MeetingState = {
  active: false,
  startedAt: null,
  title: null,
  project: null,
  finishing: false,
  error: null,
  liveChunks: [],
  transcribing: false,
};

const CHUNK_INTERVAL_MS = 5_000;

/**
 * Same hallucination filter the palette uses on dictation. Whisper-tiny
 * outputs "Thank you." / "you" for silent or noisy chunks; we'd rather
 * skip those than pollute the live transcript.
 */
function cleanChunkText(raw: string): string {
  const stripped = raw
    .replace(/\[\s*BLANK[_ ]AUDIO\s*\]/gi, '')
    .replace(/\[\s*INAUDIBLE\s*\]/gi, '')
    .replace(/\[\s*MUSIC\s*\]/gi, '')
    .replace(/\(\s*silence\s*\)/gi, '')
    .replace(/\(\s*music\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = stripped.toLowerCase().replace(/[.!?,;:'"-]+$/, '').trim();
  if (
    normalized === '' ||
    normalized === 'thank you' ||
    normalized === 'thanks' ||
    normalized === 'you' ||
    normalized === '.'
  ) {
    return '';
  }
  return stripped;
}

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
  /** Sample offset where the previous chunk ended (at source rate). */
  private chunkCursor = 0;
  /** Auto-increment id for live chunks. */
  private nextChunkId = 1;
  private chunkTimer: ReturnType<typeof setInterval> | null = null;

  getState(): MeetingState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(title: string, project: string | null = null): Promise<void> {
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
    this.chunkCursor = 0;
    this.nextChunkId = 1;
    this.setState({
      active: true,
      startedAt: Date.now(),
      title,
      project,
      finishing: false,
      error: null,
      liveChunks: [],
      transcribing: false,
    });
    // Live transcription: every CHUNK_INTERVAL_MS, slice the audio
    // captured since the previous cursor and send to whisper. Cheap on
    // M-series; boundary words can clip but final stop() pass uses the
    // full PCM so the saved transcript is whole.
    this.chunkTimer = setInterval(() => {
      void this.tickChunk();
    }, CHUNK_INTERVAL_MS);
  }

  private async tickChunk(): Promise<void> {
    const capture = this.capture;
    if (!capture || !this.state.active) return;
    const end = capture.capturedSamples();
    const start = this.chunkCursor;
    const rate = capture.sampleRate() ?? 48_000;
    if (end - start < rate * 1.0) {
      // Less than ~1s of new audio — skip this tick, wait for more.
      return;
    }
    const pcm = capture.sliceResampled(start, end);
    this.chunkCursor = end;
    if (!pcm || pcm.length === 0) return;
    const offsetMs =
      this.state.startedAt != null ? Date.now() - this.state.startedAt : 0;
    this.setState({ ...this.state, transcribing: true });
    try {
      const raw = await window.jarvis.transcribe(pcm.buffer as ArrayBuffer);
      const text = cleanChunkText(raw);
      if (text) {
        const chunk: LiveTranscriptChunk = {
          id: this.nextChunkId++,
          offsetMs,
          text,
        };
        this.setState({
          ...this.state,
          liveChunks: [...this.state.liveChunks, chunk],
          transcribing: false,
        });
      } else {
        this.setState({ ...this.state, transcribing: false });
      }
    } catch {
      // Transient transcribe failures (e.g. model busy) just skip; the
      // next tick picks up.
      this.setState({ ...this.state, transcribing: false });
    }
  }

  async stop(): Promise<void> {
    const capture = this.capture;
    if (!this.state.active || !capture) return;
    this.capture = null;
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    const title = this.state.title ?? 'Untitled meeting';
    const startedAt = this.state.startedAt ?? Date.now();
    const project = this.state.project;
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
        project,
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
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    this.setState({ ...INITIAL_STATE });
  }

  private setState(next: MeetingState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}

export const meetingRecorder = new MeetingRecorder();
