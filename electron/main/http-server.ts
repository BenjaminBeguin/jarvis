import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { LaunchTaskRequest } from '@shared/types';

import { parseIntent } from './intent-router.js';
import type { InboxStore } from './inbox.js';
import type { ReminderStore } from './reminders.js';
import { asTaskOrigin, type TaskRunner } from './task-runner.js';

/**
 * Localhost HTTP API for Jarvis. Mounts on 127.0.0.1 with a fixed port +
 * bearer-token auth. Same shape as the IPC layer — every IPC handler with
 * a useful external-driver shape has an HTTP equivalent. Designed for:
 *
 *   - iOS Shortcuts ("Run skill X from my phone")
 *   - CLI clients (jarvis attach, jarvis run)
 *   - CI / cron / external schedulers triggering Jarvis tasks
 *   - Future phone/web client
 *
 * What this is NOT: a remote-control surface for the renderer (still IPC),
 * nor a public-facing API (127.0.0.1 only, never bind to 0.0.0.0).
 *
 * Auth model: every request needs `Authorization: Bearer <token>`. Token
 * is auto-generated on first launch, stored in macOS Keychain, surfaced
 * in Settings → API. Single token shared across all clients; user can
 * rotate it from Settings.
 */

const PORT = 4747;

export interface HttpDeps {
  runner: TaskRunner;
  reminders: ReminderStore;
  inbox: InboxStore;
  token: string;
  version: string;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  url: string;
}

export async function startHttpServer(deps: HttpDeps): Promise<HttpServerHandle | null> {
  const server = createServer((req, res) => handle(req, res, deps).catch((err) => {
    console.error('HTTP handler crashed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
  }));

  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(
          `HTTP API: port ${PORT} in use — server not started. ` +
          'Check if Jarvis is already running, or another service.',
        );
        resolve(null);
        return;
      }
      console.warn('HTTP API: failed to start:', err);
      resolve(null);
    });
    server.listen(PORT, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${PORT}`;
      console.log(`HTTP API listening on ${url}`);
      resolve({
        url,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// ─── router ──────────────────────────────────────────────────────────────────

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<void> {
  // CORS: only relevant for browser clients hitting localhost (rare but
  // possible). Permissive on localhost since we already require a bearer
  // token — no readable-by-default endpoints.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // GET /v1/status is unauthenticated so clients can ping before bothering
  // with auth. Everything else requires a valid bearer token.
  if (req.method === 'GET' && path === '/v1/status') {
    sendJson(res, 200, { ok: true, name: 'jarvis', version: deps.version });
    return;
  }

  if (!isAuthorized(req, deps.token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  // POST /v1/intent — runs free text through the palette intent parser.
  // Returns either a launched task or a created reminder.
  if (req.method === 'POST' && path === '/v1/intent') {
    const body = await readJson(req);
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      sendJson(res, 400, { error: 'prompt required' });
      return;
    }
    const intent = parseIntent(prompt);
    if (intent.kind === 'reminder') {
      const reminder = deps.reminders.create({
        body: intent.body,
        mode: intent.mode,
        fireAt: intent.fireAt,
        cron: intent.cron,
      });
      sendJson(res, 200, { kind: 'reminder', reminder });
      return;
    }
    const task = deps.runner.launch({
      prompt: intent.body,
      origin: asTaskOrigin(typeof body?.origin === 'string' ? body.origin : 'api'),
    });
    sendJson(res, 200, { kind: 'task', task });
    return;
  }

  // POST /v1/tasks — direct task launch with optional skill / resume.
  if (req.method === 'POST' && path === '/v1/tasks') {
    const body = await readJson(req);
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) {
      sendJson(res, 400, { error: 'prompt required' });
      return;
    }
    const req2: LaunchTaskRequest = {
      prompt,
      skillId: typeof body?.skillId === 'string' ? body.skillId : undefined,
      origin: 'api',
      resumeSessionId:
        typeof body?.resumeSessionId === 'string' ? body.resumeSessionId : undefined,
    };
    const task = deps.runner.launch({
      ...req2,
      origin: asTaskOrigin(req2.origin),
    });
    sendJson(res, 200, task);
    return;
  }

  // GET /v1/tasks — recent tasks (live + history merged).
  if (req.method === 'GET' && path === '/v1/tasks') {
    sendJson(res, 200, deps.runner.list());
    return;
  }

  // GET /v1/tasks/:id — task summary + events.
  const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && taskMatch) {
    const id = taskMatch[1]!;
    const events = deps.runner.getEvents(id);
    const summary = deps.runner.list().find((t) => t.id === id);
    if (!summary) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { summary, events });
    return;
  }

  // POST /v1/tasks/:id/abort — graceful stop.
  const abortMatch = path.match(/^\/v1\/tasks\/([^/]+)\/abort$/);
  if (req.method === 'POST' && abortMatch) {
    const ok = deps.runner.abort(abortMatch[1]!);
    sendJson(res, 200, { ok });
    return;
  }

  // GET /v1/inbox — current cached items.
  if (req.method === 'GET' && path === '/v1/inbox') {
    sendJson(res, 200, deps.inbox.list());
    return;
  }

  // POST /v1/inbox/refresh — re-run every source.
  if (req.method === 'POST' && path === '/v1/inbox/refresh') {
    const items = await deps.inbox.refresh();
    sendJson(res, 200, items);
    return;
  }

  // POST /v1/reminders — schedule a reminder / action.
  if (req.method === 'POST' && path === '/v1/reminders') {
    const body = await readJson(req);
    const reminderBody = typeof body?.body === 'string' ? body.body : '';
    const fireAt = typeof body?.fireAt === 'number' ? body.fireAt : 0;
    const mode = body?.mode === 'scheduled' ? 'scheduled' : 'reminder';
    if (!reminderBody.trim() || fireAt <= 0) {
      sendJson(res, 400, { error: 'body + fireAt required' });
      return;
    }
    const reminder = deps.reminders.create({ body: reminderBody, mode, fireAt });
    sendJson(res, 200, reminder);
    return;
  }

  sendJson(res, 404, { error: 'route not found', path, method: req.method });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // Constant-time-ish compare to discourage timing attacks. Token is high-
  // entropy so a length-check fast-path is fine.
  const presented = m[1]!.trim();
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      // Cap at 1 MB to avoid OOM on a misbehaving client.
      if (size > 1_000_000) {
        req.destroy(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
