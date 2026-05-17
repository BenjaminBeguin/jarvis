import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AuthContext } from './task-runner.js';

export interface ClassifyResult {
  awaiting: boolean;
  reason: string;
}

interface CacheEntry extends ClassifyResult {
  ts: number;
}

const MAX_CACHE_ENTRIES = 5000;
const MAX_CONCURRENT = 3;
const CALL_TIMEOUT_MS = 5_000;
const FLUSH_DEBOUNCE_MS = 500;
const MAX_MESSAGE_CHARS = 4_000;

const SYSTEM_PROMPT = `You are given the last assistant message in a chat. Decide if the user is expected to send another reply.

Y = the assistant asked a question, requested a choice, listed options, is blocked on input/permission, or otherwise needs the user to act.
N = the assistant signed off, completed the task, summarized, or delivered info without asking for anything next.

Respond with exactly one line in this format:
Y|<2-6 word reason>
or
N|<2-6 word reason>`;

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

function parseResponse(text: string): ClassifyResult | null {
  const line = text.trim().split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  const match = /^([YN])\s*\|\s*(.+)$/i.exec(line.trim());
  if (!match) return null;
  return {
    awaiting: match[1]!.toUpperCase() === 'Y',
    reason: match[2]!.trim(),
  };
}

export class IntentClassifier {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ClassifyResult | null>>();
  private auth: AuthContext;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cachePath: string, auth: AuthContext) {
    this.auth = auth;
    this.load();
  }

  setAuth(auth: AuthContext): void {
    this.auth = auth;
  }

  async classify(message: string): Promise<ClassifyResult | null> {
    const trimmed = message.trim();
    if (!trimmed) return null;
    const key = sha1(trimmed);
    const cached = this.cache.get(key);
    if (cached) {
      // LRU touch — re-insert so it lives at the end.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { awaiting: cached.awaiting, reason: cached.reason };
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.run(trimmed)
      .then((result) => {
        if (result) {
          this.store(key, result);
        }
        return result;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private async run(message: string): Promise<ClassifyResult | null> {
    await this.acquire();
    try {
      return await this.invoke(message);
    } catch {
      return null;
    } finally {
      this.release();
    }
  }

  private async invoke(message: string): Promise<ClassifyResult | null> {
    const truncated =
      message.length > MAX_MESSAGE_CHARS
        ? `${message.slice(0, MAX_MESSAGE_CHARS)}…`
        : message;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const options: Record<string, unknown> = {
        abortController: controller,
        systemPrompt: SYSTEM_PROMPT,
        permissionMode: 'bypassPermissions',
        env: this.buildEnv(),
        settingSources: [],
        maxTurns: 1,
        allowedTools: [],
        mcpServers: {},
        model: 'claude-haiku-4-5',
      };
      if (
        this.auth.mode === 'subscription' &&
        this.auth.claudeBinaryPath
      ) {
        options['pathToClaudeCodeExecutable'] = this.auth.claudeBinaryPath;
      } else if (this.auth.mode === 'api-key' && !this.auth.apiKey) {
        // No usable auth — bail before spawning anything.
        return null;
      } else if (
        this.auth.mode === 'subscription' &&
        !this.auth.claudeBinaryPath
      ) {
        return null;
      }
      const stream = query({
        prompt: truncated,
        options: options as Parameters<typeof query>[0]['options'],
      });
      let text = '';
      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        const m = msg as {
          type?: string;
          message?: { content?: unknown[] };
        };
        if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          for (const block of m.message.content) {
            if (
              block &&
              typeof block === 'object' &&
              (block as { type?: string }).type === 'text' &&
              typeof (block as { text?: unknown }).text === 'string'
            ) {
              text += (block as { text: string }).text;
            }
          }
        }
      }
      return parseResponse(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildEnv(): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') base[k] = v;
    }
    delete base['ANTHROPIC_API_KEY'];
    delete base['CLAUDE_CODE_OAUTH_TOKEN'];
    if (this.auth.mode === 'api-key' && this.auth.apiKey) {
      base['ANTHROPIC_API_KEY'] = this.auth.apiKey;
    } else if (
      this.auth.mode === 'subscription' &&
      this.auth.claudeOauthToken
    ) {
      base['CLAUDE_CODE_OAUTH_TOKEN'] = this.auth.claudeOauthToken;
    }
    return base;
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  private store(key: string, result: ClassifyResult): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Drop oldest (Map preserves insertion order).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { ...result, ts: Date.now() });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        const entries: Record<string, CacheEntry> = {};
        for (const [k, v] of this.cache) entries[k] = v;
        writeFileSync(this.cachePath, JSON.stringify(entries), 'utf8');
      } catch {
        // disk full / permissions: drop silently, cache stays in-memory.
      }
    }, FLUSH_DEBOUNCE_MS);
  }

  private load(): void {
    if (!existsSync(this.cachePath)) return;
    try {
      const raw = readFileSync(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      const entries = Object.entries(parsed)
        .filter(
          ([, v]) =>
            v && typeof v.awaiting === 'boolean' && typeof v.reason === 'string',
        )
        .sort((a, b) => (a[1].ts ?? 0) - (b[1].ts ?? 0));
      for (const [k, v] of entries.slice(-MAX_CACHE_ENTRIES)) {
        this.cache.set(k, v);
      }
    } catch {
      // corrupt cache — start fresh.
    }
  }
}
