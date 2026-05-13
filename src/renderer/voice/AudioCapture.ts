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
