# Jarvis

Personal AI operating layer for builders. Electron + React desktop app on top of the Claude Agent SDK. See `~/.claude/plans/hey-i-would-love-staged-dewdrop.md` for the full plan.

## Phase 0 — what's wired

- Electron + electron-vite + React + TypeScript scaffold
- Main-process `TaskRunner` over `@anthropic-ai/claude-agent-sdk`
- SQLite (`better-sqlite3`) for task + event persistence
- Keychain (`keytar`) for the Anthropic API key
- Tray icon + global shortcut (⌘⇧J) that opens a frameless palette
- Observatory window with task list, streamed transcript, abort button
- Web Speech API push-to-talk in the palette
- `electron-builder` config + macOS entitlements (mic, network)

## Getting started

```sh
nvm use            # node 20
npm install        # builds native deps via electron-builder install-app-deps
npm run dev        # electron-vite dev with HMR
```

On first launch the observatory opens and prompts for your Anthropic API key (stored in the macOS Keychain, never on disk). Then press ⌘⇧J anywhere to summon the palette, type or hold the mic icon to dictate, hit Enter.

## Build a standalone app

```sh
npm run dist:mac
```

DMGs land in `release/`. Notarization is not configured by default — add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` env vars before `dist:mac` once you're ready to ship.

## Layout

```
electron/
  main/        # main process: SDK, DB, tray, IPC
  preload/     # contextBridge API (window.jarvis)
src/
  renderer/    # React app (Observatory + Palette + Setup)
  shared/      # IPC channel names + Task types
resources/     # icons, entitlements
```

## What's next

Phase 1 is the MVP shippable slice: load skills from `~/.jarvis/skills/*/SKILL.md`, palette-driven skill picker, persistent history view filters. Phase 2 adds MCP + routines.
