# Wake word · "Hey Jarvis"

## Why

⌘⇧J is fast, but it's still a hand-on-keyboard motion. For hands-free
moments — driving (please don't), cooking, in a meeting where you can't
type — a wake word would be transformative.

## What

A lightweight always-on listener that wakes the palette on "Hey
Jarvis" (or a configurable phrase). After the wake, the existing
voice flow kicks in: mic captures, Whisper transcribes, palette
dispatches.

## How (rough)

- **Detection model**: not Whisper — way too heavy to run always-on.
  Use a small wake-word detector. Options:
  - **Picovoice Porcupine** — best quality, $0 for personal use, has
    a Node binding. Closed-source model file. Trains custom wake
    words via their web tool.
  - **openWakeWord** — open source, ONNX-based, decent. Heavier than
    Porcupine but no service dependency.
  - **Custom whisper-tiny gated** — run whisper on 1s sliding window
    looking for the phrase. Burns CPU; not great.
  Lean Porcupine for v1.
- Always-on audio capture into a 2-second ring buffer; feed each
  frame into the detector; on hit, fire `openPalette()` + start
  recording via existing AudioCapture.
- macOS background mic access: needs the existing
  `NSMicrophoneUsageDescription` plus the user-facing trust dance.
  Probably gets flagged as a privacy concern (always-on mic).
- Toggle in settings: enable / disable wake word entirely.

## Tradeoffs / risks

- **Battery + CPU**. Always-on detection at ~30Hz is real cost on
  laptops. Should pause on battery if user opts in.
- **Privacy red flag**. "Always-on mic" is the kind of thing that
  scares users. Make it explicitly opt-in, never default. Show a tray
  indicator when the wake detector is active.
- **False trigger fatigue**. Cheap detectors mis-fire on "they
  jarvis", "hey jenny", etc. Tune the threshold + provide a
  confidence floor.

## Effort

~1 week. Mostly UX (settings toggle, tray indicator, false-trigger
recovery), not detector code.

## Related

- Voice transcription (shipped) — the wake just hands off to the
  same Whisper path.
