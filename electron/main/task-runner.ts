import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type {
  LaunchTaskRequest,
  TaskEvent,
  TaskOrigin,
  TaskStatus,
  TaskSummary,
} from '@shared/types';
import { appendTaskEvent, insertTask, updateTaskStatus } from './db.js';
import type { McpConfigStore } from './mcp-config.js';
import type { SkillRecord, SkillStore } from './skill-store.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are Jarvis, the user\'s personal AI operating layer. Be concise, direct, and helpful. Prefer action over commentary.';

interface TaskRecord {
  summary: TaskSummary;
  abort: AbortController;
  events: TaskEvent[];
  nextSeq: number;
}

export class TaskRunner extends EventEmitter {
  private readonly records = new Map<string, TaskRecord>();
  private skills: SkillStore | null = null;
  private mcp: McpConfigStore | null = null;

  setSkillStore(store: SkillStore): void {
    this.skills = store;
  }

  setMcpStore(store: McpConfigStore): void {
    this.mcp = store;
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
    rec.abort.abort();
    return true;
  }

  abortAll(): void {
    for (const rec of this.records.values()) {
      if (rec.summary.status === 'running') rec.abort.abort();
    }
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
    const record: TaskRecord = {
      summary,
      abort: new AbortController(),
      events: [],
      nextSeq: 0,
    };
    this.records.set(id, record);
    insertTask(summary);
    this.emit('status', summary);

    // Fire-and-forget; never block main loop.
    void this.run(record, req.prompt, skill);
    return summary;
  }

  private async run(
    record: TaskRecord,
    prompt: string,
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
      };
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

      const stream = query({ prompt, options });

      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        this.recordEvent(record, msg);
        if ((msg as { type?: string }).type === 'result') {
          const r = msg as unknown as { total_cost_usd?: number };
          if (typeof r.total_cost_usd === 'number') cost = r.total_cost_usd;
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
      const endedAt = Date.now();
      record.summary = {
        ...record.summary,
        status: finalStatus,
        endedAt,
        costUsd: cost,
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
