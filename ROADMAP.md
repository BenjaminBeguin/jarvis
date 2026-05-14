# Roadmap

Strategic direction for Jarvis. This is opinionated and meant to age well —
not a checkbox list. For shippable, scoped feature ideas see
[docs/backlog/INDEX.md](docs/backlog/INDEX.md); for the day-to-day
architecture see [CLAUDE.md](CLAUDE.md).

## What we're building

A personal AI operating layer for software engineers (and, increasingly,
everyone who builds). The thesis: as more of the work shifts to AI, the
limiting factor stops being _writing_ code and becomes _orchestrating_ it —
deciding what should run, where, with what context, and validating the
result. Jarvis is the home base for that orchestration.

Three things make it work:

1. **Skills** — markdown files that encode "how I want Claude to handle a
   class of problem." User-authored, version-controlled, shareable.
2. **Project memory** — a per-project markdown scratchpad agents read at
   the start of a task and append to at the end. Compounds over time so
   the 10th PR review of a repo is sharper than the first.
3. **Modules** — TS code that adds new palette intents, mid-meeting
   triggers, feeds, etc. Skills are configuration; modules are
   capabilities.

Action-driven (verbal triggers + the palette), project-driven (scope picker
+ memory), module-driven (extensible). Memory is the moat.

## Current state (2026-05)

Shipped: voice + text palette, intent routing (tasks / reminders /
scheduled actions / module verbal triggers), Whisper-small local STT,
Observatory + Constellation, project scope, project memory, MCP config +
playground, routines, 10 built-in skills, modules (quick-note,
meeting-recorder, send, pr-workflows, status, skill-suggester,
shell-nav, shell, claude-code-watch).

Architecture (after the May refactor):

```
electron/main/
  index.ts                ── slim bootstrap (lifecycle, stores, wiring)
  ipc/<domain>.ts         ── one file per IPC domain; each takes IpcDeps
  modules/<id>.ts         ── built-in modules
  seeds/skills/<name>.ts  ── built-in SKILL.md templates
  <domain>.ts             ── pure stores (Electron-free)
src/renderer/views        ── React, hash-routed
src/shared/{ipc,types}.ts ── the wire contract between main + renderer
```

Stores (`skill-store`, `project-store`, `routines`, `reminders`,
`task-runner`, `mcp-config`, etc.) deliberately don't import from
`electron` — they're the substrate that survives a future move to a
service runtime.

## Strategic directions

### 1. Headless run-mode (the "service-mode" unlock)

**Why:** the user wants Jarvis to keep working when the laptop is closed.
Reminders firing at 2pm should run even if they're at lunch. Multi-machine
later: phone → cloud Jarvis → execute and notify.

**Where we already are:** every store is Electron-free; `ipc/<domain>.ts`
files are pure dependency-injected handlers that map 1:1 to HTTP routes.
Voice transcription is renderer-side (whisper.cpp swap in
[backlog](docs/backlog/whisper-cpp.md) makes it portable).

**Path forward:**

1. Decide split point: easiest is **embed the core in a small Hono/Express
   server** that runs alongside the Electron app, listens on localhost.
   The Electron renderer talks to it via fetch instead of IPC. Same
   architecture, ready to be moved off-machine.
2. Replace `notifications` (Electron's `Notification`) with a pluggable
   notifier — local for desktop, push/SMS for remote. Currently lives
   in `electron/main/index.ts` and the `ipc/intent.ts` reminder handler.
3. Replace `~/.jarvis/` direct file access with a `Storage` interface that
   has `FsStorage` (current) + future `S3Storage` / `LibsqlStorage`. Most
   stores already touch the FS through a single method — feasible.
4. Migrate auth: Anthropic OAuth on the desktop today, server-side
   OAuth + Claude API key (or user-scoped subscription) on the cloud.

See [daemon-split.md](docs/backlog/daemon-split.md) for the minimal version
(same machine, separate process). Cloud is the same shape, further away.

### 2. Skills as the killer feature

Skills are already great. To level up:

- **Skill marketplace / sharing** — a skill is one markdown file. Make it
  trivial to publish (one-click GitHub gist) and install (paste URL → drop
  into `~/.jarvis/skills/`). Pre-vet built-ins in a curated index.
- **Skill versioning + self-update** — when a built-in seed has changed,
  surface "an update is available" in Dashboard with a diff view. User
  accepts or keeps their fork. Today the seeder only overwrites broken
  YAML, never live ones.
- **Skill metrics** — which skills the user runs, success rate, cost. Use
  this to surface "you used `commit-helper` 47 times this month" and
  also to prune ones nobody touches.
- **Skill composition** — see [skill-chaining](docs/backlog/skill-chaining.md).
  A `pr-review-queue` task spawning `pr-address-comments` as a child
  task, tracked on the constellation. Today modules can launch tasks but
  skills can't easily call skills.

### 3. Project memory becomes a real moat

Today: agents read `~/.jarvis/projects/<slug>/memory/*.md` at the start
of a task, append at the end. Free-form markdown, no structure.

Next:

- **Quality control.** Agents sometimes append low-signal notes ("the
  project uses TypeScript"). Build a periodic `memory-trim` skill that
  re-reads memory and prunes the obvious / outdated, leaves the real
  gems. Manual edit via the Projects tab is already there.
- **Cross-project memory** at `~/.jarvis/memory/` for things that
  generalise (the user's style, recurring tools, hard rules). Already
  partially there via the global skill prompts; lifting to first-class
  storage with the same agent-read-and-append pattern would let the
  user's "operating manual" build itself.
- **Memory search / surface in the palette.** "What did we decide about
  rate limiting last quarter?" → the palette finds the relevant memory
  file and reads it back. Today the constellation visualises memory
  but doesn't search it.

### 4. Proactive Jarvis (move from reactive to ambient)

The palette is great at "I have a thought → execute it." Less great at
"there's something you should know." A few moves toward ambient:

- **Smart palette suggestions** — see
  [smart-suggestions.md](docs/backlog/smart-suggestions.md). When the
  palette opens, show one context-aware hint ("2 PRs waiting on you",
  "meeting in 5 min") instead of generic placeholders.
- **Calendar awareness** — see
  [calendar-aware.md](docs/backlog/calendar-aware.md). Read macOS
  Calendar, auto-prompt `/meeting` when an event starts, end-of-day
  recap of what happened.
- **Standing routines that watch.** Already have node-cron routines.
  Add a pattern for "every 15 min, if X, fire Y" — most usefully:
  "every 15 min, look for new PR comments on my open PRs and fire
  pr-address-comments if there are any." The cron handles this today;
  the missing piece is a UI to author conditional routines without
  hand-editing JSON.

### 5. Multi-user readiness (small things, early)

The user said they may share this. Things to keep in mind, not solve now:

- **Single-user assumptions in storage.** `~/.jarvis/` is per-machine
  per-user. The day there are users, this becomes `<userId>/.jarvis/`
  or a DB-backed layout — but every store touches this path. Wrapping
  in a `Workspace` abstraction now avoids a sed-style rewrite later.
- **Hardcoded paths in skill prompts.** Built-in SKILL.md files
  reference `~/.jarvis/projects/...` verbatim. Templates with a
  `{{WORKSPACE}}` placeholder would survive multi-user.
- **Secrets storage.** macOS Keychain via keytar today. Trivially
  swappable to a server-side secret store (AWS Secrets Manager,
  Vault, env vars) — already isolated in `electron/main/secrets.ts`.
- **No analytics, no telemetry.** Keep it that way until user opts in.
- **No login UI.** Anthropic API key + a single user. First multi-user
  move is probably "Jarvis Cloud" with per-user OAuth, not adding
  password fields here.

## Near-term focus (next 1-3 weeks)

Pick from these — they pay off fast and don't bloat the system:

1. **Smart palette suggestions** (1-2 days). High UX win, low risk. Spec
   in [backlog](docs/backlog/smart-suggestions.md).
2. **Skill chaining MVP** (3-4 days). Lets `pr-review-queue` actually
   queue follow-ups. Architectural cornerstone for #3 below.
3. **Cost dashboard** (1-2 days). Surfaces what we've spent and on
   what. Builds awareness for proactive features later.
4. **One real "ambient" routine** — e.g. "every morning at 08:30,
   run `status` + `daily-brief`, send the combined output to the
   palette HUD." Stress-tests the routine + skill + notification path.
5. **External module loader** — see
   [external-modules.md](docs/backlog/external-modules.md). Unlocks
   sharing modules later. Probably needs more design than 3 days.

## Architectural runway (don't skip when adding the above)

Touch these as you go, not all at once:

- **Wrap `~/.jarvis/` in a `Workspace` type** with `read/write/glob`. Even
  if the implementation just delegates to `fs/promises` today, the seam
  is what makes service-mode + multi-user feasible without a
  big-bang rewrite. The `ProjectMemoryStore` is a decent template.
- **One IPC handler / domain pattern enforced** ([ipc/](electron/main/ipc/)).
  Each new domain gets its own `ipc/<name>.ts`, not appended to an
  existing one. Keeps `index.ts` boring.
- **Schema for SKILL.md frontmatter** in a single place so the runner,
  the seeder, the editor, and the marketplace agree. Currently
  duplicated between `skill-store.ts` and `skill-author.ts` seed.
- **Don't add a test framework yet.** Cost > benefit at this size. Add
  it the first time we have a clear, ongoing bug-class (regressions
  in intent routing? in MCP probing?). Per-domain `ipc/<name>.ts`
  files make individual handlers easy to unit-test when that day
  comes.

## What we explicitly _don't_ do

- Mobile-native app (use the future Cloud + web instead).
- LangChain / DSPy / agent framework. Claude Agent SDK is the runtime.
- Vector DB. Memory is markdown files; agents read them whole. We can
  add semantic search the day a project has >50 memory files.
- A plugin marketplace before there are 10 users.
- Onboarding flow / tutorial. Documentation IS the onboarding — see
  CLAUDE.md.

## Pointers

- [CLAUDE.md](CLAUDE.md) — the in-repo agent guide; read first.
- [docs/backlog/INDEX.md](docs/backlog/INDEX.md) — scoped feature backlog.
- [README.md](README.md) — what Jarvis is, for someone arriving cold.
