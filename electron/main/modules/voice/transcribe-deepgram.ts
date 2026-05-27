import { getDeepgramApiKey } from '../../secrets.js';

/**
 * Deepgram-backed meeting transcription. The Float32Array PCM is
 * encoded as a 16-bit linear PCM WAV in memory, POSTed to Deepgram's
 * /v1/listen endpoint with speaker diarization on, and the response
 * parsed into speaker-labeled paragraphs.
 *
 * Why Deepgram over OpenAI Whisper API:
 *   - Diarization out of the box. OpenAI's transcribe endpoints
 *     return one continuous string with no speaker labels.
 *   - 10–30x faster than local whisper-base for long meetings.
 *   - Robust to silence; no "be going to be going to be going"
 *     hallucination loops that local Whisper exhibits when the
 *     audio gets quiet.
 *
 * Cost: ~$0.0043/min with diarization. A 60-min meeting is
 * ~$0.26. New Deepgram accounts ship with $200 of credit, which
 * is roughly 775 hours.
 *
 * Falls back gracefully — if no API key, throws a friendly error
 * the caller can present to the user with a setup hint.
 */

interface DeepgramParagraph {
  speaker: number;
  start: number;
  end: number;
  sentences?: Array<{ text: string; start: number; end: number }>;
  text?: string;
}

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        paragraphs?: {
          paragraphs?: DeepgramParagraph[];
        };
      }>;
    }>;
  };
  err_code?: string;
  err_msg?: string;
}

export interface DeepgramTranscriptResult {
  /** Plain transcript text, with speaker headers when diarization
   *  surfaced multiple voices. Same string that lands in the
   *  meeting markdown body. */
  text: string;
  /** Best-guess count of distinct speakers Deepgram detected. */
  speakerCount: number;
  /** Total audio duration as Deepgram interpreted it (seconds). */
  durationSec: number;
}

/**
 * Run Deepgram transcription on raw 16-kHz mono PCM. Returns a
 * structured object the meeting-recorder can write to disk.
 */
export async function transcribeDeepgram(
  pcm: Float32Array,
  opts: { language?: string } = {},
): Promise<DeepgramTranscriptResult> {
  const key = await getDeepgramApiKey();
  if (!key) {
    throw new Error(
      'Deepgram API key not set. Settings → Modules → Voice → Deepgram API key.',
    );
  }
  const wav = encodeWavLinearPcm16(pcm, 16_000);
  const lang = opts.language || 'en';
  // Endpoint reference:
  //   https://developers.deepgram.com/reference/listen-file
  // Knobs in order of importance:
  //   - model=nova-3 — current best general-purpose ASR.
  //   - diarize=true — speaker labels.
  //   - punctuate=true — needed for paragraph splitting.
  //   - smart_format=true — capitalisation + dates + numbers + …
  //   - paragraphs=true — Deepgram chunks the transcript into
  //     speaker-coherent paragraphs (much nicer than per-word).
  //   - utterances=false — paragraphs supersede utterances for
  //     human reading.
  const url =
    `https://api.deepgram.com/v1/listen` +
    `?model=nova-3&language=${encodeURIComponent(lang)}` +
    `&diarize=true&punctuate=true&smart_format=true&paragraphs=true&filler_words=false`;

  // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob ctor
  // gets a clean BodyInit shape. The TS lib distinguishes ArrayBuffer
  // from ArrayBufferLike (which includes SharedArrayBuffer); Node's
  // Buffer is the latter and TS won't pass it through fetch directly.
  const wavBytes = new Uint8Array(wav.byteLength);
  wavBytes.set(wav);
  const blob = new Blob([wavBytes], { type: 'audio/wav' });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${key}`,
      'Content-Type': 'audio/wav',
    },
    body: blob,
  });
  if (!res.ok) {
    // Deepgram returns JSON error bodies even on non-2xx.
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as DeepgramResponse;
      if (errBody.err_msg) detail = errBody.err_msg;
    } catch {
      // Body wasn't JSON; keep the status-only detail.
    }
    if (res.status === 401) {
      throw new Error(`Deepgram rejected the API key (${detail}).`);
    }
    throw new Error(`Deepgram transcribe failed: ${detail}`);
  }
  const body = (await res.json()) as DeepgramResponse;
  const alt = body.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) {
    throw new Error('Deepgram returned no transcript.');
  }
  const paragraphs = alt.paragraphs?.paragraphs ?? [];
  const speakerSet = new Set<number>();
  for (const p of paragraphs) speakerSet.add(p.speaker);
  const speakerCount = speakerSet.size;
  const text =
    paragraphs.length > 0
      ? formatParagraphs(paragraphs, speakerCount > 1)
      : (alt.transcript ?? '');
  return {
    text,
    speakerCount,
    durationSec: pcm.length / 16_000,
  };
}

/**
 * Render Deepgram paragraphs as a markdown-style transcript. When
 * multiple speakers were detected, each paragraph gets a header:
 *
 *   **Speaker 1** [00:23]
 *   We were thinking about the rollout plan…
 *
 *   **Speaker 2** [00:41]
 *   Yeah, I'd push back on the timing.
 *
 * When only one speaker is detected, we drop the headers and
 * write a continuous flow — a solo monologue doesn't benefit from
 * "Speaker 1:" at every paragraph break.
 */
function formatParagraphs(
  paragraphs: DeepgramParagraph[],
  showSpeakers: boolean,
): string {
  const blocks: string[] = [];
  for (const p of paragraphs) {
    const text = paragraphText(p);
    if (!text.trim()) continue;
    if (showSpeakers) {
      const stamp = formatTimestamp(p.start);
      blocks.push(`**Speaker ${p.speaker + 1}** [${stamp}]\n${text}`);
    } else {
      blocks.push(text);
    }
  }
  return blocks.join('\n\n');
}

function paragraphText(p: DeepgramParagraph): string {
  if (typeof p.text === 'string' && p.text.length > 0) return p.text;
  const sentences = p.sentences ?? [];
  return sentences.map((s) => s.text).join(' ');
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Encode a Float32Array (signed, -1..1) of mono PCM at the given
 * sample rate as a 16-bit linear PCM WAV blob. Deepgram accepts
 * raw audio uploads as long as the WAV header is well-formed.
 *
 * No external lib — the format is dead simple and we already do
 * this kind of thing for the meeting recorder's local-Whisper
 * path.
 */
function encodeWavLinearPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);
  let offset = 0;
  // RIFF header
  buf.write('RIFF', offset); offset += 4;
  buf.writeUInt32LE(36 + dataSize, offset); offset += 4;
  buf.write('WAVE', offset); offset += 4;
  // fmt subchunk
  buf.write('fmt ', offset); offset += 4;
  buf.writeUInt32LE(16, offset); offset += 4; // PCM = 16
  buf.writeUInt16LE(1, offset); offset += 2; // format = 1 (linear PCM)
  buf.writeUInt16LE(numChannels, offset); offset += 2;
  buf.writeUInt32LE(sampleRate, offset); offset += 4;
  buf.writeUInt32LE(byteRate, offset); offset += 4;
  buf.writeUInt16LE(blockAlign, offset); offset += 2;
  buf.writeUInt16LE(bitsPerSample, offset); offset += 2;
  // data subchunk
  buf.write('data', offset); offset += 4;
  buf.writeUInt32LE(dataSize, offset); offset += 4;
  // PCM samples — Float32 (-1..1) → Int16
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i] ?? 0;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    buf.writeInt16LE(Math.round(s * 0x7fff), offset);
    offset += 2;
  }
  return buf;
}
