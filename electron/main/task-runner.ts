import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type {
  AuthMode,
  LaunchTaskRequest,
  TaskEvent,
  TaskOrigin,
  TaskStatus,
  TaskSummary,
} from '@shared/types';
import { AsyncMessageQueue } from './async-message-queue.js';
import { appendTaskEvent, insertTask, updateTaskStatus } from './db.js';
import type { McpConfigStore } from './mcp-config.js';
import type { SkillRecord, SkillStore } from './skill-store.js';

const DEFAULT_SYSTEM_PROMPT = `You are Jarvis, the user's personal AI operating layer running through Claude Code.

You have a full toolbox — Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, plus any MCP servers the user has configured. Use them. Don't bluff with disclaimers when a tool can give you a real answer.

Quick heuristics:
- Time / date / system info → run \`date\`, \`uname -a\`, \`uptime\` via Bash.
- Current events, recent news, anything time-sensitive → WebSearch. If the user names a specific URL or asks "what does that page say" → WebFetch.
- Anything in the user's filesystem → Read / Glob / Grep first, don't ask them to paste.
- Multi-step tasks → just do them. Skip "should I…" preludes when the next step is obvious.

Style:
- Tight. Skip restatements of the question. Skip closing offers ("let me know if…").
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
  private auth: AuthContext = { mode: 'subscription' };

  setSkillStore(store: SkillStore): void {
    this.skills = store;
  }

  setMcpStore(store: McpConfigStore): void {
    this.mcp = store;
  }

  setAuth(ctx: AuthContext): void {
    this.auth = ctx;
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
   * Continue a Jarvis-owned task with a follow-up user message. Returns
   * false if the task is unknown, external, or no longer accepting input
   * (completed/aborted/errored).
   */
  sendMessage(taskId: string, text: string): boolean {
    const rec = this.records.get(taskId);
    if (!rec || rec.external) return false;
    if (rec.summary.status !== 'running') return false;
    if (!rec.inputs || rec.inputs.isClosed()) return false;
    rec.inputs.push(userMessage(text, rec.summary.id));
    // Echo as an event so the transcript reflects the user's reply
    // immediately, before the SDK loops back with the assistant response.
    this.recordEvent(rec, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as unknown as SDKMessage);
    // The agent is no longer awaiting — flip the meta so the UI hides the
    // reply box and shows "running".
    this.emit('status', { ...rec.summary, awaitingInput: false });
    rec.summary = { ...rec.summary, awaitingInput: false };
    return true;
  }

  /**
   * Register an entry that wasn't run by us — e.g. a Claude Code session
   * observed by the claude-code-watch module. In-memory only; the SQLite
   * tables stay reserved for tasks we actually ran.
   */
  registerExternal(summary: TaskSummary): void {
    if (this.records.has(summary.id)) return;
    const record: TaskRecord = {
      summary,
      abort: new AbortController(),
      events: [],
      nextSeq: 0,
      external: true,
    };
    this.records.set(summary.id, record);
    this.emit('status', summary);
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
    if (
      rec.summary.status === status &&
      rec.summary.endedAt === endedAt
    ) return;
    rec.summary = { ...rec.summary, status, endedAt };
    this.emit('status', rec.summary);
  }

  updateExternalMeta(taskId: string, patch: Partial<TaskSummary>): void {
    const rec = this.records.get(taskId);
    if (!rec || !rec.external) return;
    const next = { ...rec.summary, ...patch };
    // Bail if nothing actually changed — avoids broadcast noise.
    let dirty = false;
    for (const key of Object.keys(patch) as (keyof TaskSummary)[]) {
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
    const summary: TaskSummary = {
      id,
      skillId,
      title: deriveTitle(req.prompt, skill),
      status: 'running',
      origin: req.origin ?? 'palette',
      startedAt: now,
      endedAt: null,
      costUsd: 0,
      inputPreview: req.prompt.slice(0, 240),
    };
    const inputs = new AsyncMessageQueue();
    inputs.push(userMessage(req.prompt, id));
    const record: TaskRecord = {
      summary,
      abort: new AbortController(),
      events: [],
      nextSeq: 0,
      inputs,
    };
    this.records.set(id, record);
    insertTask(summary);
    this.emit('status', summary);

    // Fire-and-forget; never block main loop.
    void this.run(record, skill);
    return summary;
  }

  private async run(
    record: TaskRecord,
    skill: SkillRecord | null,
  ): Promise<void> {
    const { id } = record.summary;
    let cost = 0;
    let finalStatus: TaskStatus = 'completed';
    try {
      const systemPrompt = skill?.hasBody ? skill.body : DEFAULT_SYSTEM_PROMPT;
      const options: Parameters<typeof query>[0]['options'] = {
        abortController: record.abort,
        permissionMode: 'bypassPermissions',
        systemPrompt,
        env: this.buildEnv(),
      };
      if (
        this.auth.mode === 'subscription' &&
        this.auth.claudeBinaryPath
      ) {
        options.pathToClaudeCodeExecutable = this.auth.claudeBinaryPath;
      }
      if (skill?.allowedTools.length) options.allowedTools = skill.allowedTools;
      if (skill?.model) options.model = skill.model;
      if (skill?.mcpServers.length && this.mcp) {
        const resolved = this.mcp.resolve(skill.mcpServers);
        if (Object.keys(resolved).length > 0) {
          // The SDK's mcpServers type narrows to its own McpServerConfig union;
          // our stored configs match its shape so we cast through unknown.
          (options as unknown as { mcpServers?: unknown }).mcpServers = resolved;
        }
      }

      if (!record.inputs) {
        throw new Error('Task has no input queue');
      }
      const stream = query({ prompt: record.inputs, options });

      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        this.recordEvent(record, msg);
        const m = msg as { type?: string; total_cost_usd?: number };
        if (m.type === 'result') {
          if (typeof m.total_cost_usd === 'number') cost = m.total_cost_usd;
          // End of one turn — the SDK is now waiting for the next user
          // message from our queue. Flip the meta so the UI exposes a
          // reply box.
          record.summary = { ...record.summary, awaitingInput: true, costUsd: cost };
          this.emit('status', record.summary);
        } else if (m.type === 'assistant' || m.type === 'user') {
          // New turn underway — clear the awaiting flag if it was set.
          if (record.summary.awaitingInput) {
            record.summary = { ...record.summary, awaitingInput: false };
            this.emit('status', record.summary);
          }
        }
      }
    } catch (err) {
      const aborted = record.abort.signal.aborted;
      finalStatus = aborted ? 'aborted' : 'errored';
      this.recordEvent(record, {
        type: 'jarvis_error',
        error: err instanceof Error ? err.message : String(err),
        aborted,
      } as unknown as SDKMessage);
    } finally {
      record.inputs?.close();
      const endedAt = Date.now();
      record.summary = {
        ...record.summary,
        status: finalStatus,
        endedAt,
        costUsd: cost,
        awaitingInput: false,
      };
      updateTaskStatus(id, finalStatus, endedAt, cost);
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
