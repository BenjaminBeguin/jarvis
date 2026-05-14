# Next — gap analysis + proposals

Companion to [ROADMAP.md](../ROADMAP.md) (strategic) and
[backlog/INDEX.md](backlog/INDEX.md) (deferred). This is the
ranked, actionable list — what to build next and why.

Each proposal is **self-contained**: drop the heading into a fresh
Claude session and it should be enough to start.

## Constraints (re-grounded)

- Single user today; multi-user is _possible_ later, don't lock it out.
- Service-mode (headless / off-laptop) is a likely direction.
- Skills + memory are the moat — protect them.
- Don't reinvent the wheel; lean on Claude Agent SDK + MCP.
- Best tool for software engineers _who delegate_ — assume the human
  is the orchestrator, the agents do the work, the user manages
  multiple projects simultaneously.

## Gaps (what's missing if Jarvis is meant to be "best tool for a SE managing N projects")

1. **No unified inbox.** Observatory shows tasks; Dashboard shows
   skill suggestions. There's no single "what's waiting on me right
   now across all my projects" view. For someone juggling 3-5
   repos + Slack + Linear + meetings, this is the killer view.

2. **No proactive surfacing.** Jarvis is reactive — user types or
   speaks, Jarvis acts. The promise "AI picks the work it can do"
   needs Jarvis to itself detect _delegable_ work and propose
   ("PR #340 has 3 new review comments — run pr-address-comments?").

3. **No global user preferences.** A user's "hard rules" — "always
   show me the diff before pushing", "never `--no-verify`" — aren't
   loaded into tasks. The agent personality varies per skill, but
   there's no _ground truth_ for who-the-user-is.

4. **Standing watches don't exist.** Cron routines fire on a
   schedule. There's no "watch X for state change Y → fire Z" —
   which is the substrate for proactive Jarvis.

5. **No multi-project glance.** The scope picker selects _one_
   project. Someone managing 5 projects needs a glance view: "of my
   5 projects, here's what's hot in each."

6. **Skills are local-only.** You can't share or install one without
   pasting a markdown file by hand. No marketplace, no curated
   index. This caps the network effect of the moat.

7. **Memory has no lifecycle.** Agents append; nothing prunes.
   After N months the memory dir is a pile of trivia + gems.

8. **No HTTP API.** The day you want to drive Jarvis from a phone /
   Shortcut / curl / CI, you can't. The per-domain `ipc/*.ts`
   refactor we just did is exactly the shape that would map to
   HTTP routes — pull on the thread.

9. **Cost is invisible.** A misconfigured routine could burn $50
   overnight and you'd never notice.

10. **Project setup is a blank room.** Creating a project gives you
    a name + alias + empty memory dir. No workflow scaffolding.
    Someone onboarding their 4th project should pick a template,
    not start from zero again.

## Proposals (ranked by leverage / effort)

### P1 — Inbox: the daily-driver view ⭐

**The single highest-leverage feature for the stated goal.**

**Problem.** Observatory + Dashboard don't answer "what should I
deal with right now?" Today you have to context-switch between
Slack, GitHub, Linear, Jarvis reminders, and meeting notes to
know that.

**Proposal.** A new top-level tab **Inbox**. Pulls signals from:
- Open PRs awaiting your review (per-project, via `gh`)
- New comments on your own PRs (per-project, via `gh`)
- Slack DMs / mentions you haven't replied to (via MCP)
- Linear tickets assigned to you (via MCP)
- Reminders / scheduled actions firing today
- Failed routines from the last 24h
- Active meetings being recorded

Each row has a **1-click action**: "review now" launches
`pr-review-queue` scoped to that PR; "draft reply" launches
`/send`; "address comments" launches `pr-address-comments`; etc.

Group by **project** when scoped, by **source** when global.

**Sketch.**
- New module `inbox` (`electron/main/modules/inbox.ts`) that
  aggregates feed items via MCP probes + `gh` shell calls.
- New shared type `InboxItem { id, source, project?, title,
  age, action: { skill?, intent?, prompt } }`.
- New IPC channel `inbox:list` → returns deduped items.
- New view `src/renderer/views/Inbox.tsx` — list with filter
  chips per project + source.
- Polls every 60s in foreground; a routine refreshes every 5
  min in background.

**Effort.** 2-3 days for a real MVP. Iterate from there.

**Why now.** This is THE answer to "the user manages multiple
projects." Without it, Jarvis is a fast launcher; with it, it's
a triage centre.

---

### P2 — Global user preferences ("the operating manual") ⭐

**Problem.** Built-in skills encode opinions ("never force-push",
"draft before send"). These should be _the user's_ opinions, not
Jarvis's. Today there's no way to express them once and have
every task respect them.

**Proposal.** A single markdown file at `~/.jarvis/preferences.md`
that's **automatically prepended to every task's system prompt**
(after the skill body, before the user prompt). Edited via a
Settings panel or directly on disk.

Seed it with sensible defaults the user can edit:

```markdown
# Hard rules (apply to every task)
- Never force-push. Never push to main/master directly.
- Ask before deleting files I might still need.
- When in doubt, show me the diff before applying.

# How I work
- I use pnpm, not npm.
- I prefer one tight commit per logical change.
- For TypeScript: strict mode, no `any`.
- I never want emojis in commit messages.

# What I'm working on
- Primary: $WORK_PROJECT
- Side: $SIDE_PROJECT
```

**Sketch.**
- `preferences-store.ts`: load + watch `~/.jarvis/preferences.md`.
- TaskRunner: prepend its contents to every system prompt.
- Add a "Preferences" tile in the Settings/Modules area to
  edit + reveal-in-finder.
- Built-in skills should _stop_ encoding personal opinions where
  prefs would do; they should defer to "the user's hard rules
  in preferences.md."

**Effort.** 1 day for the plumbing; ongoing pruning of
opinionated language from built-in skills.

**Why now.** It's the single change that makes Jarvis feel like
_yours_ vs. a generic tool. Also the foundation for multi-user
later — preferences become per-user.

---

### P3 — Standing watches (event-driven routines) ⭐

**Problem.** Routines fire on cron only. There's no way to
express "when X happens, run Y." Which is the substrate for
every proactive feature.

**Proposal.** Extend the routine concept. Two flavours:

- **Cron routine** (today): `cron: '0 8 * * *'` → fires daily.
- **Watch routine** (new): `watch: 'every 5m'`, `condition: <skill or shell>`, `then: <skill+prompt>`.

The watcher runs the `condition` cheaply on each interval. If it
returns non-empty / truthy output, fires `then`. A small state
file (`~/.jarvis/.watches.json`) tracks last-fired-state so we
don't re-fire on the same condition.

Concrete: `watch: 'every 5m'`, `condition: gh-new-review-comments`,
`then: pr-address-comments`. → checks gh every 5 min; if new
comments on _any_ of my PRs, fires `pr-address-comments`.

**Sketch.**
- Extend `RoutineStore` schema with optional `watch` + `condition` fields.
- `RoutineScheduler` runs `condition` on its interval; on truthy
  result, launches `then`.
- New `watches/` dir under skills (or just regular skills returning JSON).

**Effort.** 2 days. The hard part is making `condition` skills
cheap enough to run every 5 min without hammering APIs.

**Why now.** Unlocks proactive Jarvis without coupling to
push/webhooks. Polling is fine at this scale.

---

### P4 — Workflow templates on project create ⭐

**Problem.** Creating a project leaves you in a blank room. No
seeded memory, no enabled skills, no routines. For the 4th project
in 6 months, this is friction every time.

**Proposal.** When the New Project dialog submits, optionally
pick a **workflow template**. Each template is a JSON descriptor
that seeds the project with:
- Initial memory files (e.g. one seed per topic: `build.md`,
  `conventions.md`, `pr-style.md` — empty but with prompt headers
  agents can fill in)
- Enabled built-in skills (filter to relevant ones)
- Suggested watches (pre-built routine candidates)
- Suggested MCPs to wire (e.g. "GitHub team" template suggests
  `gh` CLI + GitHub MCP)

Built-in templates: **GitHub team**, **Solo indie**, **Linear-driven**, **Open-source maintainer**, **Just exploring** (= no template).

User can extend via `~/.jarvis/templates/<name>.json`.

**Sketch.**
- `templates/` directory in seeds.
- Augment `NewProjectDialog` with a "Template" select.
- `ProjectStore.create()` runs the template after writing the
  project entry.

**Effort.** 1-2 days for 3 templates + the picker.

**Why now.** Productivity compounds — every future project gets
the user's preferred process baked in.

---

### P5 — Localhost HTTP API (the service-mode unlock)

**Problem.** Today, only the renderer can drive Jarvis. The
moment you want to:
- Trigger a skill from an iOS Shortcut
- Run a routine from CI
- Build a future phone app
- Run Jarvis on a Mac mini and access from elsewhere

…you're stuck.

**Proposal.** Mount a Hono server on `127.0.0.1:<random_port>`
that mirrors every IPC handler one-to-one as an HTTP route.
Auth via a per-install bearer token shown once in Settings.

Routes follow the IPC domain split we just did:
- `POST /tasks/launch` — `IpcChannels.launchTask`
- `POST /intent/route` — `IpcChannels.routePrompt`
- `GET /tasks` — `IpcChannels.listTasks`
- `GET /projects` — `IpcChannels.listProjects`
- etc.

The renderer keeps using IPC for now; the HTTP server is for
external clients.

**Sketch.**
- `electron/main/server/index.ts`: Hono app instance.
- Each `ipc/<domain>.ts` registers _both_ an IPC handler AND a
  Hono route — share the handler body. Trivial since each is
  already a thin function calling `deps`.
- Token via keytar.

**Effort.** 1-2 days because the per-domain split did the hard
work. Test with `curl http://127.0.0.1:.../intent/route -d
'{"prompt":"remind me in 5min to ..."}'`.

**Why now.** Removes the biggest service-mode bottleneck. Even
if you never run Jarvis on a server, scripting it from the CLI
becomes possible.

---

### P6 — Skill marketplace MVP (paste-URL install)

**Problem.** A skill is a markdown file. Today there's no way to
share or install one without copy-paste-onto-disk. This caps the
network effect.

**Proposal.** Two pieces:

1. **Install** — A "Add skill from URL" button in the Modules /
   Skills view. Fetches the URL, validates the YAML frontmatter,
   drops the file in `~/.jarvis/skills/<name>/SKILL.md`. URLs
   start with `https://` only; raw.githubusercontent.com and
   gist.githubusercontent.com get green-lit, others warn.
2. **Curated index** — a JSON file in this repo at
   `docs/skill-index.json` listing blessed skills with `{url,
   description, author}`. Browse panel in the same view.

**Sketch.**
- New IPC `installSkillFromUrl(url)` — fetch, validate, write.
- New view section `Skills` (or extend `ModulesPage`).
- `docs/skill-index.json` — start with 3-5 community skills you
  write to seed the catalog.

**Effort.** 1 day for install, ongoing for the curated list.

**Why now.** Skills are the moat — making them shareable is the
single highest-leverage growth lever if Jarvis ever gets users.

---

### P7 — Workspace abstraction (foundation work)

**Problem.** `~/.jarvis/` is touched directly by ~15 files via
`fs/promises`. The day Jarvis moves to a server / multi-user /
S3 / sqlite-backed store, that's a sed-style rewrite.

**Proposal.** A single `Workspace` interface:

```ts
interface Workspace {
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  list(rel: string): Promise<{ name: string; isDir: boolean }[]>;
  glob(pattern: string): Promise<string[]>;
  delete(rel: string): Promise<void>;
  watch(rel: string, onChange: () => void): () => void;
}
```

`FsWorkspace` is the only implementation today. Plumb it into
`ModuleContext`, the stores, the IPC handlers that touch disk.

**Sketch.**
- `electron/main/workspace.ts` — the interface + `FsWorkspace`.
- One PR: migrate `ProjectMemoryStore` (smallest) first; verify
  it still works; then `SkillStore`; then the rest.

**Effort.** 2-3 days total. Boring, valuable, no user-visible change.

**Why now.** Every other foundational direction (service-mode,
multi-user, cloud sync) leans on this. Pay the cost while the
codebase is small.

---

### P8 — Cost dashboard

**Problem.** A runaway routine can burn $50 overnight; you'd
never know.

**Proposal.** A new tile in Dashboard or a new tab **Cost** that
shows: this month's spend by skill, by project, by day; flagged
outliers; "your top 3 most-used skills cost you $X."

Tap into `runner` events — each task summary already has cost,
just need to aggregate and store.

**Sketch.**
- SQLite migration: `task_costs(taskId, skillId, project, inputTokens, outputTokens, costUsd, completedAt)`.
- Aggregation queries.
- Recharts (already in repo? check) for the bars.

**Effort.** 1-2 days.

**Why now.** Trust + safety. Especially before turning on more
proactive routines.

---

### P9 — In-app skill editor

**Problem.** To edit a skill, you `open ~/.jarvis/skills/<name>/SKILL.md`
in your editor. That's fine for power users but breaks the
"futuristic, contained app" feel.

**Proposal.** A Skills tab (or section inside Modules) with:
- List of all SKILL.md files with name + description from frontmatter
- Click → markdown editor in the right panel with live frontmatter
  validation (red border on bad YAML)
- "Duplicate this skill" creates a user copy of a built-in,
  preserves the original
- Reload button to re-source from disk

**Effort.** 2-3 days for a real one.

**Why now.** It's the surface where the user's "code-without-code"
work happens. Should feel native.

---

### P10 — Memory audit / trim

**Problem.** Agents append; nothing prunes. After N months: pile.

**Proposal.** A `memory-trim` built-in skill that re-reads every
memory file under a project, drops the obvious / outdated /
duplicate notes, leaves the high-signal ones. The user runs it
from the Projects view ("Audit memory" button) or as a monthly
routine.

**Effort.** 0.5 day for the skill (it's mostly prompt engineering)
+ 0.5 day for the UI button.

**Why now.** Memory quality compounds — bad memory makes agents
dumber, not smarter.

---

### P11 — Ambient user context (time / place / state) ⭐

**Problem.** Every task starts cold. The agent doesn't know what
day it is, what timezone the user is in, what city they're in,
whether a meeting is happening right now, or whether the user
has DND on. Result: "remind me at 3pm" needs the user to
specify timezone; "is it past EOD" requires the user to give
their working hours every time; "schedule a meeting next
Tuesday" requires explicit date math.

**Proposal.** A built-in `UserContext` block prepended to every
task's system prompt, right after `preferences.md` (P2). Built
fresh on every task launch, so it's always current. Format:

```markdown
## Current context
- Now: Thursday 2026-05-14, 14:32 (Europe/Paris, GMT+2)
- Location: Paris, France (cached, updated weekly)
- Active project: jarvis (alias: jarvis)
- Focus mode: off  (or "Work — Do Not Disturb" if on)
- Recent: last task `pr-review-queue` 8 min ago
```

This is _ambient_ data — the agent uses it implicitly without
the user having to say "I'm in Paris, btw."

**Sources, in priority order:**

1. **Time + timezone** — `Intl.DateTimeFormat().resolvedOptions()`,
   always available. Day name + ISO date + HH:MM + tz abbrev.
2. **Active project** — already in the scope picker (~/.jarvis
   localStorage broadcast). Plug in.
3. **Focus mode / DND** — macOS `shortcuts run` or `defaults read
   com.apple.controlcenter` for state. Best-effort, gracefully
   degrades.
4. **Location** — IP geo on first run (api.ipgeolocation.io or
   similar, no key needed for city-level), cached in
   `~/.jarvis/.user-context.json` with a 7-day TTL. User can edit
   the cache directly to override or empty it.
5. **Recent activity** — last 1-2 task titles + age. Already in
   `runner.list()`.
6. **Calendar (future, depends on calendar-aware backlog item)** —
   "in 'Standup' meeting until 14:45". Plug in once Calendar
   module exists.

**Sketch.**

- `electron/main/user-context.ts`: pluggable provider pattern:
  ```ts
  interface UserContextProvider {
    name: string;
    build(): Promise<string | null>;  // markdown line(s) or null
  }
  ```
- Built-in providers for time + active project. Optional providers
  for focus mode + location.
- `UserContextStore`: composes providers, returns a markdown
  block. Caches stable bits (location) and refreshes volatile
  bits (time) every call.
- `TaskRunner.run()` prepends the block to the system prompt.
  Order: `[user-preferences] [user-context] [skill body]`.
- Modules can `ctx.registerContextProvider(provider)` to add
  sources — calendar, currently-open-app, recent-activity, etc.

**Effort.** 0.5 day for the MVP (just time + tz + active project
+ recent task). +0.5 day for focus mode + location.

**Why now.** Every. Single. Task. Gets. Smarter. Free. Pairs
naturally with P2 — preferences ("how I work") + context ("where
I am right now") = the agent finally has both halves of "who is
this person, in this moment."

**Why it might be a module vs. built-in.** I'd start built-in
(always on, simplest path) and use the provider pattern so
modules can _add_ context sources without owning the substrate.
This avoids the "user disables UserContext module → time
disappears" failure mode.

---

### P12 — Resume Jarvis sessions in Claude Code (CLI + Desktop) ⭐

**Problem.** Jarvis owns the task surface. But sometimes you want
to "pop the hood" — keep going from a Jarvis-spawned conversation
in your normal Claude Code session, where you have full
permission gates, your shell, your branching, your familiar
tooling. Today there's no exit hatch.

**Why this is mostly free.** In **subscription mode**, every Jarvis
task IS a real Claude Code session under the hood. The Agent SDK
spawns the `claude` CLI as a subprocess; the session is written
to disk in Claude Code's session store
(`~/.claude/projects/<hash>/<session>.jsonl`). Claude Code Desktop
reads the same store. **The sessions already appear in
Desktop's "Recent" list — Jarvis just doesn't surface this fact
or make jumping into a specific one easy.**

**Proposal (three flavors, increasing effort, all worth doing).**

**A. Reveal session id + jump buttons.** In TaskDetail, show the
Claude Code session id with two affordances:
- **"Open in Claude Code Desktop"** — fire `shell.openExternal('claude-code://session/<id>')` if Desktop registers a URL scheme. (Verify the scheme name first — many Electron apps do; if not, fall back to revealing the session file in Finder.)
- **"Copy resume command"** — copy `claude --resume <id>` to clipboard. Paste into any terminal, you're back in the conversation in the CLI.

Subscription-mode tasks only — api-key tasks don't have a Claude
Code session record. Show a small "subscription-only" hint when
the mode is api-key.

Effort: **half a day**. The session id is already captured by
the runner (it's how Jarvis tracks the conversation); just plumb
it through `TaskSummary` → IPC → TaskDetail view.

**B. `jarvis attach <task-id>` CLI.** A tiny binary that hits the
localhost HTTP API (P5) and renders the task's event stream to
the terminal as styled text. Works for **both** subscription and
api-key tasks because it goes through Jarvis's IPC, not Claude
Code's session store. Bonus: `jarvis attach --last` for the most
recent task.

Effort: **1 day** after P5 lands. Mostly a colour-formatting layer
on top of the event stream.

**C. "Continue in terminal" handoff.** A button on a running task:
gracefully stops Jarvis's iterator (so we don't have two writers
on the same session) and presents `claude --resume <id>` for the
user to paste. Useful when Jarvis spawned the task autonomously
(routine, reminder) and the user wants to take over driving.

Effort: **2-3 hours** on top of A. Just a "stop + copy" flow.

**Sketch.**

- Add `sessionId` to `TaskSummary` (already in `TaskRecord` internally;
  just expose it).
- TaskDetail view gets a small footer row: `Session: abc123 · Copy resume · Open in Desktop`.
- Add a `IpcChannels.openInClaudeDesktop` handler that does the
  `shell.openExternal` — keep the URL scheme in one place, easy
  to swap if it turns out Desktop uses something different.
- For (C): a new IPC `tasks:handoff` that aborts the runner's
  iterator cleanly (not `abort()` — that emits `aborted` status;
  a `handoff()` that emits a new `'handed-off'` status would
  read better in the timeline).

**Watch out for.**

- **Don't `--resume` while Jarvis still has the iterator
  running.** Two writers on one session = undefined behavior.
  The Copy-resume button should be visible only on `completed`
  or `errored` tasks, OR fire the handoff abort first. Easy to
  enforce in the UI.
- **Permission model gap.** Jarvis runs with `bypassPermissions`;
  Claude Code (CLI + Desktop) is interactive. New turns after
  resume go through normal permission gates — actually a feature,
  not a bug, since the user is now driving manually.
- **URL scheme uncertainty.** I'm not 100% sure Claude Code
  Desktop registers `claude-code://` or similar. Worst case the
  button reveals the session file in Finder + the user opens
  Desktop manually; their "Recent" list already shows it.

**Why now.** Reframes Jarvis from "parallel universe" to "layer
on top of Claude Code." The skill investments, the project memory,
the routines all stay in Jarvis — but the conversation itself
flows freely between surfaces. Especially powerful with
Desktop: see a task in Jarvis Observatory → one click → it's in
Desktop with full UI. The mirror module
(`claude-code-watch.ts`) already does the inverse direction; this
is the natural pair.

**Direction reminder.** This isn't replacing Jarvis's surface —
it's adding an exit hatch. The Observatory + Constellation +
palette + Inbox all stay primary. Claude Code is the "I want to
take the wheel now" alternative.

---

## Stretch / less obvious

### Memory search in the palette

Type `?<query>` or use a `/recall` intent → semantic-ish search
across project memories + recent meetings + notes, with snippets.
Today the palette can route to skills but can't surface
remembered context.

### Multi-project Constellation

The Constellation today scopes to one project. Add a "global"
mode that pans across all projects with project clusters. Same
SVG, layered grouping.

### Watch + diff for built-in skill updates

When a built-in skill template improves, the user gets a
notification with a diff. Accept → overwrite their copy; keep
fork → ignore.

### CLI binary

`jarvis run <skill> [input]` → talks to the localhost HTTP API
(P5 prerequisite). Backlog has this; bumping its priority
post-P5 makes sense.

### Wake word

In the backlog. Genuinely low-value for the daily-driver SE
use-case — typing or hold-to-talk is faster. Defer indefinitely.

## Suggested sequencing

If you have 2 weeks of focused work:

1. Week 1: **P2 (preferences)** + **P11 (user context)** + **P12-A (Claude Code jump)** + **P1 (Inbox)** + **P4 (templates)**.
   P2 + P11 + P12-A are all "half a day each" — knock them out
   first. P2 and P11 share the prepend-to-system-prompt plumbing;
   P12-A just plumbs the session id through. Then Inbox (2-3
   days), then templates. Together: the agent knows the user in
   the moment, the user can pop into Claude Code Desktop when
   they want, and Inbox is the daily-driver triage view.
2. Week 2: **P3 (watches)** + **P5 (HTTP API)** + **P7 (Workspace)**.
   Foundation moves. Workspace first because the API should
   consume it. P12-B + P12-C land naturally as a 1-day add-on
   after P5.

After two weeks, the daily-driver UX is dramatically better, and
the foundation for service-mode is in place.

## Things I deliberately did NOT propose

- Test framework (no real bug class to test against yet)
- Multi-user UI (premature; preferences-as-per-user is enough
  scaffolding for now)
- Auth provider beyond Anthropic OAuth + API key (single-user)
- Native iOS/Android app (use the HTTP API + a thin web client
  when the day comes)
- A vector DB (markdown + agent context is fine at this scale)
- Skill DAG editor (the underlying mechanism — skill chaining —
  is the prerequisite; the editor is sugar)

## How to pick this up later

Each P# above can be handed to a fresh Claude session with
something like:

> "Read [docs/NEXT.md](docs/NEXT.md), implement P2 (global user
> preferences). Look at how `ProjectMemoryStore` is wired for a
> template — it's the closest analog."

The sketches give enough context to start without re-reading the
whole codebase.
