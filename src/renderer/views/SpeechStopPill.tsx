import { useEffect, useState } from 'react';

/**
 * Floating "STOP SPEAKING" pill — visible only while macOS `say` is
 * actually playing audio. Click to cancel.
 *
 * Sits bottom-right above the toast area so it doesn't overlap with
 * notification stacks. Subscribed to the main-process speechEvents
 * via a single IPC channel, so any in-flight TTS — voice-loop reply,
 * /speak intent, Telegram bot mirror — shows the pill.
 *
 * Global keyboard shortcut (⌘⇧.) also stops speech without needing
 * this UI; the pill is the discoverable alternative.
 */
export function SpeechStopPill() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const off = window.jarvis.onSpeechActive((value) => {
      setActive(!!value);
    });
    return () => {
      off?.();
    };
  }, []);

  if (!active) return null;

  return (
    <button
      type="button"
      className="speech-stop-pill"
      onClick={() => void window.jarvis.stopSpeaking()}
      title="Stop the agent talking (⌘⇧.)"
      aria-label="Stop speaking"
    >
      <span className="speech-stop-pill__dot" aria-hidden />
      <span className="speech-stop-pill__label">STOP SPEAKING</span>
      <span className="speech-stop-pill__hint">⌘⇧.</span>
    </button>
  );
}
