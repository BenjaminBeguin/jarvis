/**
 * Capture mic audio as 16kHz mono Float32 PCM, ready to hand straight to
 * Whisper via IPC. Replaces the Web Speech API path (Electron can't reach
 * Google's speech service, so it always failed with `network`).
 *
 * Implementation notes:
 *  - ScriptProcessorNode is deprecated but still ships in Chromium. The
 *    AudioWorkletNode alternative needs a separate worklet file + module
 *    plumbing, which is heavier than this short clip use case warrants.
 *  - The browser may not honor a custom sampleRate on AudioContext, so we
 *    resample from whatever sample rate the OS gives us (typically 48kHz).
 *  - Linear interpolation resampler — fine for voice, terrible for music.
 */

export interface CaptureResult {
  pcm: Float32Array;
  /** Source sample rate before resampling. Useful for diagnostics. */
  sourceSampleRate: number;
}

export class AudioCapture {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    this.chunks = [];
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        // Hint only — most macOS Chromium builds run the mic at 48kHz.
        sampleRate: 16_000,
      } as MediaTrackConstraints,
    });
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      // The buffer is reused — copy before stashing.
      this.chunks.push(new Float32Array(channel));
    };
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  /**
   * Source sample rate the OS handed us, or null if not capturing.
   * Almost always 48000 on macOS.
   */
  sampleRate(): number | null {
    return this.audioContext?.sampleRate ?? null;
  }

  /**
   * Total samples captured so far at the source sample rate. Used by
   * callers polling for new audio without ending the recording (live
   * meeting transcription).
   */
  capturedSamples(): number {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    return total;
  }

  /**
   * Return the audio between two sample offsets (at source sample rate),
   * resampled to 16kHz for Whisper. Returns null if the range is empty or
   * out of bounds. Doesn't mutate state — safe to call mid-recording.
   *
   * Usage:
   *   const start = recorder.capturedSamples();
   *   // …wait 5s…
   *   const end = recorder.capturedSamples();
   *   const chunk = recorder.sliceResampled(start, end);
   *   // chunk is 16kHz mono Float32, ready for whisper
   */
  sliceResampled(startSamples: number, endSamples: number): Float32Array | null {
    if (endSamples <= startSamples) return null;
    const sourceSampleRate = this.audioContext?.sampleRate ?? 48_000;
    const wanted = endSamples - startSamples;
    const out = new Float32Array(wanted);
    let written = 0;
    let cursor = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = cursor + chunk.length;
      if (chunkEnd <= startSamples) {
        cursor = chunkEnd;
        continue;
      }
      if (cursor >= endSamples) break;
      const from = Math.max(0, startSamples - cursor);
      const to = Math.min(chunk.length, endSamples - cursor);
      if (to > from) {
        out.set(chunk.subarray(from, to), written);
        written += to - from;
      }
      cursor = chunkEnd;
    }
    if (written === 0) return null;
    const trimmed = written === wanted ? out : out.subarray(0, written);
    return resampleLinear(trimmed, sourceSampleRate, 16_000);
  }

  async stop(): Promise<CaptureResult> {
    const sourceSampleRate = this.audioContext?.sampleRate ?? 48_000;
    try {
      this.processor?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
    this.processor = null;
    this.mediaStream = null;
    this.audioContext = null;

    const totalLength = this.chunks.reduce((s, c) => s + c.length, 0);
    const concat = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      concat.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    const pcm = resampleLinear(concat, sourceSampleRate, 16_000);
    return { pcm, sourceSampleRate };
  }

  abort(): void {
    this.chunks = [];
    try {
      this.processor?.disconnect();
    } catch {
      /* ignore */
    }
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close();
    }
    this.processor = null;
    this.mediaStream = null;
    this.audioContext = null;
  }
}

function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const idx = i * ratio;
    const floor = Math.floor(idx);
    const frac = idx - floor;
    const a = input[floor] ?? 0;
    const b = input[floor + 1] ?? a;
    output[i] = a * (1 - frac) + b * frac;
  }
  return output;
}
