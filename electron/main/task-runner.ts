import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type {
  AuthMode,
  LaunchTaskRequest,
  SessionConfig,
  TaskEvent,
  TaskOrigin,
  TaskStatus,
  TaskSummary,
} from '@shared/types';
import { AsyncMessageQueue } from './async-message-queue.js';
import { appendTaskEvent, insertTask, updateTaskStatus } from './db.js';
import type { McpConfigStore } from './mcp-config.js';
import type { ProjectStore } from './projects.js';
import type { PreferencesStore } from './preferences-store.js';
import type { SkillRecord, SkillStore } from './skill-store.js';
import type { SkillSessionStore } from './skill-sessions.js';
import type { UserContextStore } from './user-context.js';

/**
 * Always prepended to every system prompt — including skill bodies that
 * fully override the default Jarvis prompt below. Without this, skills
 * have no signal that they're running inside Jarvis, and when an MCP
 * fails the model falls back to general training and tells the user to
 * "run /mcp in Claude Code" or "check ~/.claude/settings.json". Both
 * are wrong here: MCPs are configured in ~/.jarvis/mcp.json and managed
 * via the Jarvis Integrations tab.
 */
const ENVIRONMENT_PROMPT = `## Environment

You are running inside Jarvis — a macOS Electron app, not a terminal Claude Code session. MCP servers come from ~/.jarvis/mcp.json (managed by the Jarvis Integrations tab), not from ~/.claude/settings.json or claude.ai connectors.

If an MCP tool fails or returns no result:
- Diagnose like normal (look at the error, try a different tool).
- If recovery requires the user, tell them to open Jarvis's Integrations tab — that's where they enable, disable, edit, or restart MCP servers.
- Do NOT instruct the user to run \`/mcp\`, restart Claude Code, edit ~/.claude/settings.json, or visit claude.ai. Those are not the right surfaces.

## Jarvis host capabilities (mcp__jarvis__*)

You always have access to an in-process Jarvis MCP — use these instead of writing transcript text whenever you can:

- \`mcp__jarvis__notify\` — pop a macOS notification (title + body). Use for short signals you want the user to see without reading transcript.
- \`mcp__jarvis__log_activity\` — write to the Activity feed (kind + label + optional detail). Use for side-effects the user might want to look back at.
- \`mcp__jarvis__create_reminder\` — schedule a future reminder/scheduled action (body + mode + fireAt ms epoch).
- \`mcp__jarvis__open_url\` — open a URL in the user's default browser.
- \`mcp__jarvis__get_active_project\` — read the user's currently scoped project (name + path + repo, or null).
- \`mcp__jarvis__list_recent_meetings\` / \`list_recent_notes\` — enumerate recent files under ~/.jarvis/meetings or ~/.jarvis/notes.
- \`mcp__jarvis__read_project_memory\` / \`write_project_memory\` — read/append per-project memory files.

Prefer these over Bash equivalents (e.g. notify over \`osascript\`) — they're faster and keep the transcript clean.`;

const DEFAULT_SYSTEM_PROMPT = `You are Jarvis, the user's personal AI operating layer running through Claude Code.

You have a full toolbox — Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, plus any MCP servers the user has configured. Use them. Don't bluff with disclaimers when a tool can give you a real answer.

Shell commands you should reach for via Bash (assume they're installed and authenticated unless you actually hit an error):
- \`gh\` — GitHub CLI. PR/issue/comment/actions work goes through this. Examples:
  \`gh pr view 340 --repo owner/name\`, \`gh pr view 340 --comments\`,
  \`gh issue list --repo owner/name --state open\`, \`gh run list\`.
- \`git\` — status, log, diff, branches for any local repo.
- \`date\` / \`uname -a\` / \`uptime\` — clock, OS, system.
- \`curl\` / \`jq\` — quick HTTP or JSON shaping.

Heuristics:
- Pull requests, issues, comments, actions, releases → \`gh\` (cd into the project path first if you have one).
- Anything time-sensitive or "current" → WebSearch / WebFetch.
- Anything in the user's filesystem → Read / Glob / Grep. Don't ask them to paste.
- Multi-step → just do them. Skip "should I…" preludes when the next step is obvious.

Style:
- Tight. Skip restatements of the question and closing offers ("let me know if…").
- When you used a tool, mention the source/command inline so the user can verify.
- Honest about uncertainty when it actually exists, but never as a substitute for trying a tool.`;

interface TaskRecord {
  summary: TaskSummary;
  abort: AbortController;
  events: TaskEvent[];
  nextSeq: number;
  /** External entries (e.g. tailed Claude Code sessions) live in-memory only. */
  external?: boolean;
  /** Streaming input queue for multi-turn Jarvis-owned tasks. */
  inputs?: AsyncMessageQueue;
  /**
   * The session_id the SDK-spawned claude assigned to this task, learned
   * from its system/init message. Used to de-duplicate the claude-code-watch
   * mirror entry that appears for the same conversation.
   */
  sdkSessionId?: string;
  /** Per-launch SDK option overrides (mode / model / cwd / etc.).
   * Kept on the record so resume turns inherit them. */
  config?: SessionConfig;
  /** When this task was launched via skill-session pooling, the
   *  bucket key the SkillSessionStore should update once the SDK
   *  session id lands. Empty for routine / reminder fires + tasks
   *  the user explicitly launched fresh. */
  pooledBucketKey?: string;
  /** True when nobody is watching — routine fires + scheduled-action
   *  reminders. The runner closes the SDK session cleanly after the
   *  result event instead of holding it in the awaiting state, and
   *  flags the task `errored` if the final assistant text looks like
   *  a question to the user. */
  unattended?: boolean;
}

/**
 * One-line invariant: a task in a terminal status (completed / errored
 * / aborted) cannot be `awaitingInput`. Applied at every external-task
 * write point on the runner so no caller can leak the bad combo into
 * downstream consumers (Inbox AwaitingStrip, TaskList row, Constellation
 * pulse, Tray badge, …). Owned tasks never hit this — the runner's own
 * flow controls both fields directly.
 */
function normalizeAwaiting(summary: TaskSummary): TaskSummary {
  const isTerminal =
    summary.status === 'completed' ||
    summary.status === 'errored' ||
    summary.status === 'aborted';
  if (isTerminal && summary.awaitingInput) {
    return { ...summary, awaitingInput: false };
  }
  return summary;
}

function userMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * Pull the final assistant text from a task's event stream. Skips
 * tool_use blocks, thinking blocks, and other non-text content.
 * Returns null if the stream had no assistant text at all.
 */
function lastAssistantText(events: TaskEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const msg = events[i]?.msg as
      | { type?: string; message?: { content?: unknown } }
      | undefined;
    if (msg?.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    const text = (content as Array<Record<string, unknown>>)
      .flatMap((b) =>
        b['type'] === 'text' && typeof b['text'] === 'string'
          ? [b['text'] as string]
          : [],
      )
      .join('\n')
      .trim();
    if (text) return text;
  }
  return null;
}

/**
 * Heuristic: does this look like the agent stopped to ask the user
 * something? We check the tail of the message because a long report
 * can legitimately contain question marks in mid-text ("did this
 * resolve the issue? Yes, see the diff."). The signal we care about
 * is "the last sentence is a question to the user."
 *
 * False positives are tolerable here — the consequence is a routine
 * gets flagged for triage, the user reads the transcript and either
 * tightens the skill prompt or sets unattended=false on the routine.
 */
function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Last sentence ending — find the slice after the last sentence
  // terminator in the prior body.
  const tail = trimmed.slice(-240);
  // Strip trailing whitespace, then check the final non-whitespace char.
  const endsInQuestionMark = /\?\s*$/.test(tail);
  if (endsInQuestionMark) return true;
  // Phrase signals — common ways an agent asks for input without
  // ending in a literal '?' (markdown bullets, etc.).
  return /\b(let me know|please confirm|please clarify|need clarification|which (one|of these)|should i|do you want|would you like|can you (provide|share|confirm|clarify))\b/i.test(
    tail,
  );
}

export interface AuthContext {
  mode: AuthMode;
  apiKey?: string | null;
  claudeBinaryPath?: string | null;
  /** OAuth token from Claude Code's Keychain, used in subscription mode. */
  claudeOauthToken?: string | null;
}

export class TaskRunner extends EventEmitter {
  private readonly records = new Map<string, TaskRecord>();
  private skills: SkillStore | null = null;
  private mcp: McpConfigStore | null = null;
  private projects: ProjectStore | null = null;
  private userContext: UserContextStore | null = null;
  private preferences: PreferencesStore | null = null;
  private jarvisMcp: unknown = null;
  private skillSessions: SkillSessionStore | null = null;
  private auth: AuthContext = { mode: 'subscription' };

  setSkillStore(store: SkillStore): void {
    this.skills = store;
  }

  setSkillSessionStore(store: SkillSessionStore): void {
    this.skillSessions = store;
  }

  setMcpStore(store: McpConfigStore): void {
    this.mcp = store;
  }

  /** In-process MCP server exposing Jarvis-side capabilities (notify,
   *  log_activity, create_reminder, …). Constructed once in main and
   *  injected here so it lives for the runner's lifetime. */
  setJarvisMcp(mcp: unknown): void {
    this.jarvisMcp = mcp;
  }

  setProjectStore(store: ProjectStore): void {
    this.projects = store;
  }

  setUserContextStore(store: UserContextStore): void {
    this.userContext = store;
  }

  setPreferencesStore(store: PreferencesStore): void {
    this.preferences = store;
  }

  setAuth(ctx: AuthContext): void {
    this.auth = ctx;
  }

  /**
   * Working directory for the spawned Claude session. Mirrors `claude
   * --cwd <path>` — Claude Code keys its session storage by absolute
   * project path, so getting this right means the session lands in the
   * correct ~/.claude/projects/<hash>/ bucket too.
   *
   * Resolution order:
   *   1. explicit per-launch override (palette folder picker)
   *   2. active project's path
   *   3. ~ as fallback (Electron's cwd is the .app bundle — unusable)
   */
  private resolveCwd(override?: string | null): string {
    if (override && override.trim()) return override;
    const activeName = this.userContext?.getActiveProject();
    if (activeName) {
      const def = this.projects?.resolve(activeName);
      if (def?.path) return def.path;
    }
    return homedir();
  }

  /**
   * Build the system prompt for a task. Order:
   *   1. Environment header — "you're inside Jarvis, MCPs come from
   *      ~/.jarvis/mcp.json". Always prepended so skills that override
   *      the default prompt still know where they're running.
   *   2. Skill body (or default Jarvis prompt) — the task's framing.
   *   3. The user's preferences — their hard rules + how-I-work overlay.
   *   4. Ambient context block — time, active project, recent task.
   *
   * Appending rather than templating means skills with their own prompts
   * still get the same environment, preferences, and context for free.
   */
  private async composeSystemPrompt(skill: SkillRecord | null): Promise<string> {
    const base = skill?.hasBody ? skill.body : DEFAULT_SYSTEM_PROMPT;
    const sections: string[] = [ENVIRONMENT_PROMPT, base];
    if (this.preferences) {
      const prefs = this.preferences.read().trim();
      if (prefs) {
        // The user's preferences.md already contains a top-level `#
        // Preferences` heading; nest under `##` to avoid two h1s in the
        // prompt. Slice off the user's heading line if present.
        const body = prefs.replace(/^#\s+Preferences\s*\n+/i, '');
        sections.push(`## User preferences\n${body}`);
      }
    }
    if (this.userContext) {
      const block = await this.userContext.build();
      if (block) sections.push(`## Current context\n${block}`);
    }
    return sections.join('\n\n');
  }

  private buildEnv(): Record<string, string> {
    // Start from the main-process env, strip any keys that would leak the
    // wrong auth into the spawned CLI, then add what we want.
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') base[k] = v;
    }
    delete base['ANTHROPIC_API_KEY'];
    delete base['CLAUDE_CODE_OAUTH_TOKEN'];

    if (this.auth.mode === 'api-key' && this.auth.apiKey) {
      base['ANTHROPIC_API_KEY'] = this.auth.apiKey;
    } else if (this.auth.mode === 'subscription' && this.auth.claudeOauthToken) {
      // The spawned claude binary normally reads its own Keychain item, but
      // when invoked from Electron the access is denied silently. We pass
      // the token via env so the SDK / CLI authenticates without touching
      // Keychain from the child process.
      base['CLAUDE_CODE_OAUTH_TOKEN'] = this.auth.claudeOauthToken;
    }
    return isStringRecord(base) ? base : {};
  }

  list(): TaskSummary[] {
    return [...this.records.values()]
      .map((r) => r.summary)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  getEvents(taskId: string): TaskEvent[] {
    return this.records.get(taskId)?.events ?? [];
  }

  /**
   * Expose the AbortSignal for a task so external runners (e.g. the shell
   * runner) can wire their own cleanup — kill child process, close socket,
   * etc. — when the user hits Stop. Returns null if no such task.
   */
  getAbortSignal(taskId: string): AbortSignal | null {
    const rec = this.records.get(taskId);
    return rec?.abort.signal ?? null;
  }

  abort(taskId: string): boolean {
    const rec = this.records.get(taskId);
    if (!rec) return false;
    if (rec.summary.status !== 'running') return false;
    rec.inputs?.close();
    rec.abort.abort();
    return true;
  }

  abortAll(): void {
    for (const rec of this.records.values()) {
      if (rec.summary.status === 'running' && !rec.external) {
        rec.inputs?.close();
        rec.abort.abort();
      }
    }
  }

  /**
   * Continue a Jarvis-owned task with a follow-up user message. Two paths:
   *
   *   1. Stream still alive (the multi-turn happy path) — push the message
   *      onto the input queue, the SDK feeds it to claude on stdin. With
   *      `maxTurns: 200` set on the SDK options for attended tasks, this
   *      is now the default — Claude.ai-style sessions where one query()
   *      call handles the whole back-and-forth without restarting.
   *   2. Stream ended (max turns hit, abort, error, or the unattended path
   *      where maxTurns is 1). If we have an sdkSessionId from the prior
   *      turn, spawn a fresh query with `resume: sessionId` so claude
   *      reloads the conversation history and picks up where it left off.
   *      The same TaskRecord stays selected, events keep flowing into it.
   *
   * Returns false only for unknown/external tasks or owned tasks that
   * never got a session id (e.g. died before init).
   */
  sendMessage(taskId: string, text: string): boolean {
    const rec = this.records.get(taskId);
    if (!rec || rec.external) return false;

    const queueAlive =
      rec.summary.status === 'running' &&
      rec.inputs &&
      !rec.inputs.isClosed();

    if (queueAlive) {
      rec.inputs!.push(userMessage(text, rec.summary.id));
      this.recordEvent(rec, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      } as unknown as SDKMessage);
      this.emit('status', { ...rec.summary, awaitingInput: false });
      rec.summary = { ...rec.summary, awaitingInput: false };
      return true;
    }

    // Stream ended — restart as a fresh turn with resume.
    if (!rec.sdkSessionId) return false;
    const resumeId = rec.sdkSessionId;
    const skill = rec.summary.skillId
      ? this.skills?.get(rec.summary.skillId) ?? null
      : null;
    // Fresh queue + AbortController for the new turn.
    rec.inputs = new AsyncMessageQueue();
    rec.inputs.push(userMessage(text, rec.summary.id));
    rec.abort = new AbortController();
    rec.summary = {
      ...rec.summary,
      status: 'running',
      endedAt: null,
      awaitingInput: false,
    };
    this.recordEvent(rec, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as unknown as SDKMessage);
    this.emit('status', rec.summary);
    // Resume the previous session id without forking — claude appends to
    // the same JSONL it already wrote to, conversation continues cleanly.
    void this.run(rec, skill, resumeId, false);
    return true;
  }

  /**
   * Register an entry that wasn't run by us — e.g. a Claude Code session
   * observed by the claude-code-watch module. In-memory only; the SQLite
   * tables stay reserved for tasks we actually ran.
   */
  registerExternal(summary: TaskSummary): void {
    if (this.records.has(summary.id)) return;
    // Enforce the invariant at the entry point too — claude-code-watch
    // computes awaitingInput from "last log event was an assistant
    // message" before it knows whether the task is being registered
    // as already-stale (completed). If status is terminal at ingest,
    // awaitingInput cannot be true.
    const normalized = normalizeAwaiting(summary);
    const record: TaskRecord = {
      summary: normalized,
      abort: new AbortController(),
      events: [],
      nextSeq: 0,
      external: true,
    };
    this.records.set(summary.id, record);
    this.emit('status', normalized);
  }

  recordExternalEvent(taskId: string, msg: unknown): void {
    const rec = this.records.get(taskId);
    if (!rec || !rec.external) return;
    const event: TaskEvent = {
      seq: rec.nextSeq++,
      ts: Date.now(),
      msg,
    };
    rec.events.push(event);
    this.emit('event', { taskId, event });
  }

  updateExternalStatus(
    taskId: string,
    status: TaskStatus,
    endedAt: number | null,
  ): void {
    const rec = this.records.get(taskId);
    if (!rec || !rec.external) return;
    // External-task awaitingInput comes from "last log event was an
    // assistant message" — which is almost always true for a session
    // that ran to completion. When the watcher decides the file is
    // stale enough to call the task `completed`, the user is no
    // longer waiting to reply; the conversation is over. Force
    // awaitingInput off on any terminal transition so the UI doesn't
    // keep showing the amber "AGENT IS WAITING" banner.
    const isTerminal =
      status === 'completed' ||
      status === 'errored' ||
      status === 'aborted';
    const nextAwaiting = isTerminal ? false : rec.summary.awaitingInput;
    if (
      rec.summary.status === status &&
      rec.summary.endedAt === endedAt &&
      rec.summary.awaitingInput === nextAwaiting
    ) return;
    rec.summary = {
      ...rec.summary,
      status,
      endedAt,
      awaitingInput: nextAwaiting,
    };
    this.emit('status', rec.summary);
  }

  updateExternalMeta(taskId: string, patch: Partial<TaskSummary>): void {
    const rec = this.records.get(taskId);
    if (!rec || !rec.external) return;
    // Normalize after merge — if the patch tries to set awaitingInput=true
    // on a terminal task (e.g. the watcher tailed a late log line on a
    // completed session), clamp it. The status field is authoritative.
    const next = normalizeAwaiting({ ...rec.summary, ...patch });
    let dirty = false;
    for (const key of Object.keys(next) as (keyof TaskSummary)[]) {
      if (rec.summary[key] !== next[key]) {
        dirty = true;
        break;
      }
    }
    if (!dirty) return;
    rec.summary = next;
    this.emit('status', rec.summary);
  }

  hasExternal(id: string): boolean {
    return !!this.records.get(id)?.external;
  }

  launch(req: LaunchTaskRequest): TaskSummary {
    const id = nanoid(10);
    const now = Date.now();
    const skill = req.skillId ? this.skills?.get(req.skillId) ?? null : null;
    const skillId = skill?.id ?? null;
    const origin = req.origin ?? 'palette';
    const projectName =
      req.projectName ?? this.userContext?.getActiveProject() ?? null;

    // Skill-session pooling — see SkillSessionStore for policy. When
    // an explicit resumeSessionId is already on the request (e.g. the
    // user clicked "↪ Resume" in TaskDetail), respect that; pooling
    // is only the default fallback when nothing else was specified.
    let resumeSessionId = req.resumeSessionId;
    let pooledBucketKey: string | undefined;
    let pooledThisLaunch = false;
    if (!resumeSessionId && this.skillSessions && skillId) {
      const decision = this.skillSessions.decide({
        skillId,
        origin,
        projectName,
        forceFresh: req.forceFreshSession === true,
      });
      if (decision) {
        pooledBucketKey = decision.bucketKey;
        if (decision.resumeSessionId) {
          resumeSessionId = decision.resumeSessionId;
          pooledThisLaunch = true;
        }
      }
    }
    const titlePrefix = resumeSessionId ? '↪ ' : '';

    const config: SessionConfig = {
      permissionMode: req.permissionMode,
      model: req.model,
      fallbackModel: req.fallbackModel,
      cwd: req.cwd,
      additionalDirectories: req.additionalDirectories,
    };
    const summary: TaskSummary = {
      id,
      skillId,
      title: `${titlePrefix}${deriveTitle(req.prompt, skill)}`,
      status: 'running',
      origin,
      startedAt: now,
      endedAt: null,
      costUsd: 0,
      inputPreview: req.prompt.slice(0, 240),
      cwd: this.resolveCwd(config.cwd),
      routineId: req.routineId ?? null,
      reminderId: req.reminderId ?? null,
      projectName,
      pooled: pooledThisLaunch,
    };
    const inputs = new AsyncMessageQueue();
    inputs.push(userMessage(req.prompt, id));
    const record: TaskRecord = {
      summary,
      abort: new AbortController(),
      events: [],
      nextSeq: 0,
      inputs,
      config,
      ...(pooledBucketKey ? { pooledBucketKey } : {}),
      ...(req.unattended ? { unattended: true } : {}),
    };
    this.records.set(id, record);
    insertTask(summary);
    this.emit('status', summary);

    // Fire-and-forget; never block main loop.
    void this.run(record, skill, resumeSessionId);
    return summary;
  }

  private async run(
    record: TaskRecord,
    skill: SkillRecord | null,
    resumeSessionId?: string,
    forkSession = true,
  ): Promise<void> {
    const { id } = record.summary;
    let cost = 0;
    let finalStatus: TaskStatus = 'completed';
    try {
      const cfg = record.config ?? {};
      const systemPrompt = await this.composeSystemPrompt(skill);
      const options: Parameters<typeof query>[0]['options'] = {
        abortController: record.abort,
        // Default to bypassPermissions for back-compat with the rest of
        // Jarvis (routines, briefings, reminders all expect non-blocking
        // runs). Per-launch override from the palette wins.
        permissionMode: cfg.permissionMode ?? 'bypassPermissions',
        systemPrompt,
        env: this.buildEnv(),
        // SDK defaults to "isolation mode" — no MCP servers, no plugins, no
        // CLAUDE.md memory from the user's normal Claude Code setup. Opt
        // into the full config so Jarvis tasks have access to the same
        // toolbox the user has in their day-to-day claude CLI / Claude
        // Desktop sessions.
        settingSources: ['user', 'project', 'local'],
        cwd: this.resolveCwd(cfg.cwd),
        // Long-lasting sessions: keep ONE query() call alive across many
        // back-and-forth turns from the input queue, like Claude.ai does.
        // Without this, the SDK closes the stream after each turn and
        // we'd pay a fresh cold start (system prompt + tool inventory)
        // on every reply.
        //
        //   - unattended: 1 turn — a routine / scheduled action fires
        //     once and closes; we don't want the SDK subprocess hanging
        //     around waiting for input that's never coming.
        //   - attended:  200 turns — high enough to feel unbounded for
        //     human chat (palette, voice, Telegram). The SDK auto-
        //     compacts context as it grows, so token overflow handles
        //     itself; this is just a soft ceiling on per-session cost.
        maxTurns: record.unattended ? 1 : 200,
      };
      if (cfg.additionalDirectories?.length) {
        options.additionalDirectories = cfg.additionalDirectories;
      }
      if (
        this.auth.mode === 'subscription' &&
        this.auth.claudeBinaryPath
      ) {
        options.pathToClaudeCodeExecutable = this.auth.claudeBinaryPath;
      }
      if (resumeSessionId) {
        // Cast: forkSession+resume are documented but the SDK's exported
        // Options type may lag in published .d.ts versions.
        const o = options as unknown as Record<string, unknown>;
        o['resume'] = resumeSessionId;
        if (forkSession) o['forkSession'] = true;
      }
      if (skill?.allowedTools.length) options.allowedTools = skill.allowedTools;
      // Model precedence: per-launch override → skill frontmatter → SDK default.
      if (cfg.model) options.model = cfg.model;
      else if (skill?.model) options.model = skill.model;
      if (cfg.fallbackModel) options.fallbackModel = cfg.fallbackModel;
      // Compose MCP servers passed to the spawned CLI via --mcp-config:
      //
      //   - With a skill: only the servers the skill opts into via
      //     `mcp-servers` frontmatter (or '*' to inherit everything).
      //     A skill's narrow list is intentional — a /note skill
      //     shouldn't be able to email people.
      //   - Without a skill (free-text palette prompts): inherit ALL
      //     configured non-disabled stdio servers. The user typing
      //     "send a slack message to Luca" has no way to opt the
      //     phantom-skill into a specific set, so giving the agent
      //     access to everything matches the mental model ("I
      //     configured Slack, of course the agent can use it").
      //   - Always include the in-process "jarvis" server.
      //
      // Skills with restrictive `allowed-tools` can scope `mcp__jarvis__*`
      // if they want to limit the host surface.
      const mcpServers: Record<string, unknown> = {};
      if (this.mcp) {
        const wanted = skill?.mcpServers.length ? skill.mcpServers : ['*'];
        const resolved = this.mcp.resolve(wanted);
        for (const [k, v] of Object.entries(resolved)) mcpServers[k] = v;
      }
      if (this.jarvisMcp) {
        mcpServers['jarvis'] = this.jarvisMcp;
      }
      if (Object.keys(mcpServers).length > 0) {
        (options as unknown as { mcpServers?: unknown }).mcpServers = mcpServers;
      }

      if (!record.inputs) {
        throw new Error('Task has no input queue');
      }
      const stream = query({ prompt: record.inputs, options });
      console.log(`[task ${id}] starting query loop`);

      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        this.recordEvent(record, msg);
        const m = msg as { type?: string; subtype?: string; total_cost_usd?: number };
        if (m.type === 'result') {
          if (typeof m.total_cost_usd === 'number') cost = m.total_cost_usd;
          console.log(`[task ${id}] result received, awaiting next user msg (queue closed: ${record.inputs?.isClosed()})`);
          // End of one turn — the SDK is waiting for the next user
          // message from our queue.
          //   - attended: flip awaiting=true so the UI exposes a reply
          //     box and the task-awaiting notifier fires (Telegram bot
          //     gets the heads-up with Approve/Edit/Cancel buttons).
          //   - unattended (routine / scheduled-action): leave awaiting
          //     alone. No one's going to reply; flipping it briefly
          //     before the finally block resets it would still leak a
          //     "ready for your reply" notification through the
          //     awaitingFlipped watcher.
          if (record.unattended) {
            record.summary = { ...record.summary, costUsd: cost };
          } else {
            record.summary = { ...record.summary, awaitingInput: true, costUsd: cost };
          }
          this.emit('status', record.summary);
        } else if (m.type === 'assistant' || m.type === 'user') {
          // New turn underway — clear the awaiting flag if it was set.
          if (record.summary.awaitingInput) {
            record.summary = { ...record.summary, awaitingInput: false };
            this.emit('status', record.summary);
          }
        }
      }
      console.log(`[task ${id}] query loop EXITED naturally (abort.aborted: ${record.abort.signal.aborted}, queue closed: ${record.inputs?.isClosed()})`);
    } catch (err) {
      const aborted = record.abort.signal.aborted;
      console.log(`[task ${id}] query loop THREW`, err, `aborted: ${aborted}`);
      finalStatus = aborted ? 'aborted' : 'errored';
      this.recordEvent(record, {
        type: 'jarvis_error',
        error: err instanceof Error ? err.message : String(err),
        aborted,
      } as unknown as SDKMessage);
    } finally {
      console.log(`[task ${id}] finally: status=${finalStatus}, cost=${cost}, sdkSessionId=${record.sdkSessionId}`);
      record.inputs?.close();
      const endedAt = Date.now();

      // Unattended tasks (routine fires, scheduled-action reminders): no
      // one is watching, so we never leave the session in the awaiting
      // state. If the agent's final text looks like a question to the
      // user, that's a buggy skill prompt — flag as errored so the
      // failed-routines Inbox source surfaces it for triage.
      if (record.unattended && finalStatus === 'completed') {
        const finalText = lastAssistantText(record.events);
        if (finalText && looksLikeQuestion(finalText)) {
          finalStatus = 'errored';
          this.recordEvent(record, {
            type: 'jarvis_error',
            error:
              'Unattended fire ended in a question to the user. Tighten the skill prompt (give defaults / explicit instructions) or set unattended=false on this routine.',
            aborted: false,
          } as unknown as SDKMessage);
        }
      }

      // If the SDK stream ended cleanly AND we know the session id, keep
      // the task alive in an "awaiting" state — sendMessage() will spin up
      // a fresh query() with resume: sessionId on the next reply. Without
      // this, the SDK closing the stream after a single turn (which we've
      // seen in production despite multi-turn streaming working in
      // isolation) would lock the user out of further replies.
      //
      // Unattended tasks always close (no one is going to reply).
      const canResume =
        finalStatus === 'completed' &&
        !!record.sdkSessionId &&
        !record.unattended;
      const nextStatus: TaskStatus = canResume ? 'running' : finalStatus;
      const nextAwaiting = canResume;
      const nextEndedAt = canResume ? null : endedAt;

      record.summary = {
        ...record.summary,
        status: nextStatus,
        endedAt: nextEndedAt,
        costUsd: cost,
        awaitingInput: nextAwaiting,
      };
      updateTaskStatus(id, nextStatus, nextEndedAt, cost);
      this.emit('status', record.summary);
    }
  }

  private recordEvent(record: TaskRecord, msg: unknown): void {
    const event: TaskEvent = {
      seq: record.nextSeq++,
      ts: Date.now(),
      msg,
    };
    record.events.push(event);
    appendTaskEvent(record.summary.id, event);
    this.emit('event', { taskId: record.summary.id, event });

    // If the SDK has just announced its session id, remember it + drop any
    // claude-code-watch mirror that's tracking the same JSONL — otherwise
    // the user sees two entries for one conversation (the Jarvis-owned task
    // here, and a duplicate external session).
    if (!record.external) {
      const m = msg as { type?: string; subtype?: string; session_id?: string };
      if (
        m.type === 'system' &&
        m.subtype === 'init' &&
        typeof m.session_id === 'string' &&
        !record.sdkSessionId
      ) {
        record.sdkSessionId = m.session_id;
        record.summary.sdkSessionId = m.session_id;
        // Persist + emit so TaskDetail can light up its "Open in Claude
        // Code Desktop" buttons the moment the session id lands.
        updateTaskStatus(
          record.summary.id,
          record.summary.status,
          record.summary.endedAt,
          record.summary.costUsd,
          m.session_id,
        );
        this.emit('status', record.summary);
        const mirrorId = `cc-${m.session_id}`;
        if (this.records.has(mirrorId)) this.removeExternal(mirrorId);
        // If this task was pooled (no explicit resume but a skill +
        // user-initiated origin), record the turn so the next launch
        // for the same bucket can resume it. The SDK can return a
        // different session_id than the one we asked to resume (it
        // forks under some conditions); the store handles that
        // automatically — same key, new id, turn counter resets.
        if (record.pooledBucketKey && this.skillSessions) {
          this.skillSessions.recordTurn(record.pooledBucketKey, m.session_id);
        }
      }
    }
  }

  /** True if any Jarvis-owned task is bound to this claude session id. */
  isOwnedSessionId(sessionId: string): boolean {
    for (const rec of this.records.values()) {
      if (!rec.external && rec.sdkSessionId === sessionId) return true;
    }
    return false;
  }

  removeExternal(taskId: string): boolean {
    const rec = this.records.get(taskId);
    if (!rec || !rec.external) return false;
    this.records.delete(taskId);
    this.emit('removed', taskId);
    return true;
  }
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null;
}

function deriveTitle(prompt: string, skill: SkillRecord | null): string {
  const first = prompt.trim().split('\n')[0] ?? '';
  const trimmed = first.length > 80 ? first.slice(0, 77) + '…' : first;
  if (skill && trimmed) return `${skill.name} · ${trimmed}`;
  if (skill) return skill.name;
  return trimmed || 'Untitled task';
}

export function asTaskOrigin(value: unknown): TaskOrigin {
  return value === 'voice' || value === 'routine' || value === 'api'
    ? value
    : 'palette';
}
