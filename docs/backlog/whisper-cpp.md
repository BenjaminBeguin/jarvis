# whisper.cpp swap

## Why

Current setup uses `Xenova/whisper-small` via `@huggingface/transformers`
(transformers.js running ONNX in pure JS). Works, but:

- ~466MB model download per machine.
- transformers.js + ONNX add ~30MB of runtime deps to the bundle.
- Inference is on the JS thread (or Web Worker via the lib); a bit
  slower than native.
- One npm package versioning hiccup away from breaking the renderer
  (we already had a sharp / libvips conflict).

whisper.cpp gives us: native CPU/GPU code (Metal on macOS),
quantized models, same accuracy band, no JS-side ML deps.

## What

Drop-in replacement for `transcribePcm()`. Same signature, same
input shape (Float32 16kHz mono). The only thing the rest of the app
sees is faster + less RAM. No UI changes.

## How (rough)

- Pick a binding: `nodejs-whisper` (Node bindings) or shell out to a
  bundled `whisper-cli` binary. Bindings simpler, binary more portable.
- Bundle a small whisper.cpp model (e.g. `ggml-small-q5_1.bin`,
  ~250MB) — or download on first use, same as today.
- Replace the body of `electron/main/transcribe.ts` while keeping the
  same exported function. Keep the `VoiceTranscriber` interface stable
  — that's why we wrote the seam earlier.
- Drop the transformers.js dep from `package.json`.
- Test that Metal acceleration kicks in on Apple Silicon.

## Tradeoffs / risks

- **Native bindings break on `electron-rebuild`**. We've already
  fought this with `better-sqlite3` + `keytar`. Adding another native
  dep is more of the same — work, not novel.
- **Cross-platform**. We're macOS-only today; whisper.cpp ships
  cross-platform binaries so this stays OK.
- **Binary size**. whisper.cpp bundled adds maybe 10MB. Acceptable.

## Effort

~2 sessions including testing. Lower priority — current setup works.
Bump up if transformers.js bites us or we want to ship to users on
older Intel Macs (where ONNX is meaningfully slower).

## Related

- Live transcription (shipped) — same code path; faster Whisper means
  smaller chunk boundaries become viable.
