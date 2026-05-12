// Thin wrapper around the Web Speech API. Replaceable in Phase 3 with whisper.cpp.

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported(): boolean {
  return getCtor() !== null;
}

export interface VoiceTranscriber {
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export interface VoiceCallbacks {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}

export function createTranscriber(callbacks: VoiceCallbacks): VoiceTranscriber | null {
  const Ctor = getCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i]!;
      const transcript = result[0]?.transcript ?? '';
      // Web Speech results expose isFinal on the result object; we use any
      // transcript reaching the last result as the final read.
      const isFinal = (result as unknown as { isFinal?: boolean }).isFinal;
      if (isFinal) final += transcript;
      else interim += transcript;
    }
    if (interim && callbacks.onPartial) callbacks.onPartial(interim);
    if (final) callbacks.onFinal(final.trim());
  };
  rec.onerror = (event) => callbacks.onError?.(event.error);
  rec.onend = () => callbacks.onEnd?.();
  return {
    start: () => rec.start(),
    stop: () => rec.stop(),
    abort: () => rec.abort(),
  };
}
