import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';

import type { LaunchTaskRequest, TrayMenuState } from '@shared/types';

import { decodeAudioToFloat32 } from './audio-dispatch.js';
import { parseIntent } from './intent-router.js';
import type { InboxStore } from './inbox.js';
import type { OAuthOrchestrator } from './oauth/orchestrator.js';
import type { notifier as NotifierInstance } from './notifier.js';
import type { ReminderStore } from './reminders.js';
import { asTaskOrigin, type TaskRunner } from './task-runner.js';
import { transcribePcm } from './modules/voice/transcribe.js';

/**
 * HTTP API for Jarvis. Mounts on a fixed port + bearer-token auth.
 * Same shape as the IPC layer — every IPC handler with a useful
 * external-driver shape has an HTTP equivalent. Designed for:
 *
 *   - iOS Shortcuts ("Run skill X from my phone")
 *   - CLI clients (jarvis attach, jarvis run)
 *   - CI / cron / external schedulers triggering Jarvis tasks
 *   - The mobile PWA reaching the Mac over Tailscale
 *
 * Bind address: `0.0.0.0` so the Tailscale interface accepts
 * connections from the phone. Localhost is still served, and the
 * bearer-token check guards every authenticated route, so LAN
 * exposure is not a free read of internal data.
 *
 * Auth model: every authenticated request needs `Authorization:
 * Bearer <token>`. Token is auto-generated on first launch, stored
 * in macOS Keychain, surfaced in Settings → API. Single token
 * shared across all clients; user can rotate it from Settings.
 */

const PORT = 4747;
/** How often the SSE keepalive + snapshot tick fires. Doubles as
 *  a "current state" rebroadcast so a phone that just reconnected
 *  gets the latest counts without having to also re-GET
 *  /v1/status/details. */
const SSE_TICK_MS = 5_000;

export interface HttpDeps {
  runner: TaskRunner;
  reminders: ReminderStore;
  inbox: InboxStore;
  oauth: OAuthOrchestrator;
  notifier: typeof NotifierInstance;
  /** Returns the current status snapshot (mode + counts + pinned).
   *  Same shape the tray menu consumes; reused here so SSE +
   *  /v1/status/details stay in lockstep with the desktop UI. */
  getStatus(): TrayMenuState;
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
    server.listen(PORT, '0.0.0.0', () => {
      // The `url` we return is the loopback one — used by Settings
      // → API + by callers on the same machine. The phone reaches
      // the same server via the Tailscale hostname (printed for
      // diagnostics) or any other interface address.
      const url = `http://127.0.0.1:${PORT}`;
      console.log(`HTTP API listening on ${url} (also: http://${hostname()}:${PORT})`);
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

  // GET /mobile — placeholder until vite-plugin-pwa wires the
  // real renderer build into a static handler. The phone hits
  // this URL after scanning the pairing QR; the placeholder
  // confirms reachability + bearer-token roundtrip before the
  // PWA shell ships.
  if (req.method === 'GET' && path === '/mobile') {
    sendHtml(res, 200, mobilePlaceholder(deps.version));
    return;
  }

  // OAuth callbacks come from the user's browser after consent, with no
  // way to attach our bearer token. The flow is protected by the OAuth
  // `state` nonce matched inside the orchestrator instead.
  const oauthMatch = path.match(/^\/oauth\/callback\/([^/]+)$/);
  if (req.method === 'GET' && oauthMatch) {
    const provider = oauthMatch[1]!;
    try {
      await deps.oauth.handleCallback(provider, url.searchParams);
      sendHtml(res, 200, successPage(provider));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendHtml(res, 400, errorPage(provider, msg));
    }
    return;
  }

  if (!isAuthorized(req, url, deps.token)) {
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

  // POST /v1/tasks/:id/message — append a user reply to a
  // running / resumable task. Returns { ok } so the phone can
  // show "sent" feedback; the actual agent response streams via
  // the SSE task.status event + refetch.
  const messageMatch = path.match(/^\/v1\/tasks\/([^/]+)\/message$/);
  if (req.method === 'POST' && messageMatch) {
    const body = await readJson(req);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'text required' });
      return;
    }
    const ok = deps.runner.sendMessage(messageMatch[1]!, text);
    sendJson(res, ok ? 200 : 409, { ok });
    return;
  }

  // GET /v1/status/details — authenticated counts + app mode +
  // pinned conversations. Same snapshot the tray menu consumes,
  // so phone + desktop never drift.
  if (req.method === 'GET' && path === '/v1/status/details') {
    sendJson(res, 200, deps.getStatus());
    return;
  }

  // GET /v1/status/live — SSE stream. Phone connects once and
  // receives:
  //   event: status        every SSE_TICK_MS, payload = full snapshot
  //   event: notif         on each notifier.post (NotificationEvent)
  //   event: task.status   on each TaskRunner status change
  // The keepalive comment lines keep idle proxies / phone radios
  // from closing the connection.
  if (req.method === 'GET' && path === '/v1/status/live') {
    handleSseStatus(req, res, deps);
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

  // POST /v1/audio/dispatch — phone uploads a voice blob, we
  // decode + transcribe + dispatch via routePrompt's same flow
  // as the desktop ⌘⇧Space orb. Body is raw audio bytes
  // (Content-Type from MediaRecorder — usually `audio/webm` on
  // iOS). Returns the new task id + transcript so the PWA can
  // navigate straight to the conversation.
  if (req.method === 'POST' && path === '/v1/audio/dispatch') {
    const buf = await readRawBody(req, 25 * 1024 * 1024); // 25 MB cap
    if (!buf || buf.length === 0) {
      sendJson(res, 400, { error: 'empty body' });
      return;
    }
    let pcm: Float32Array;
    try {
      pcm = await decodeAudioToFloat32(buf);
    } catch (err) {
      sendJson(res, 400, {
        error:
          err instanceof Error
            ? `audio decode failed: ${err.message}`
            : 'audio decode failed',
      });
      return;
    }
    if (pcm.length < 16_000 * 0.3) {
      sendJson(res, 400, { error: 'audio too short' });
      return;
    }
    let text: string;
    try {
      text = (await transcribePcm(pcm)).trim();
    } catch (err) {
      sendJson(res, 500, {
        error:
          err instanceof Error
            ? `transcribe failed: ${err.message}`
            : 'transcribe failed',
      });
      return;
    }
    if (!text) {
      sendJson(res, 400, { error: "couldn't make out audio" });
      return;
    }
    const task = deps.runner.launch({
      prompt: text,
      origin: 'voice',
    });
    sendJson(res, 200, { taskId: task.id, text });
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

function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  // Two accepted forms:
  //   - `Authorization: Bearer <token>` (default; used by fetch + custom clients)
  //   - `?token=<token>` query (fallback for EventSource, which can't
  //     attach custom headers). Same token, same constant-time compare.
  let presented = '';
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) presented = m[1]!.trim();
  }
  if (!presented) {
    const q = url.searchParams.get('token');
    if (q) presented = q;
  }
  if (!presented) return false;
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

async function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      if (size > maxBytes) {
        req.destroy(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
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

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

/**
 * Server-Sent Events: holds the response open and streams events
 * to the phone (or any EventSource client). Cleanup runs on
 * 'close' so a dropped connection doesn't leak the subscriptions.
 */
function handleSseStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable reverse-proxy buffering (Nginx / Cloudflare) — Tailscale
  // is direct so this is mostly defensive but the header is harmless.
  res.setHeader('X-Accel-Buffering', 'no');
  // Flush headers immediately so the client sees the connection open.
  res.write(': connected\n\n');

  const write = (event: string, payload: unknown): void => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      console.warn('[sse] write failed', err);
    }
  };

  // First payload: current snapshot. Phone renders before waiting
  // for the first tick.
  write('status', deps.getStatus());

  const unsubNotif = deps.notifier.subscribe((evt) => {
    write('notif', evt);
  });
  const onTaskStatus = (summary: unknown): void => write('task.status', summary);
  deps.runner.on('status', onTaskStatus);

  const tick = setInterval(() => {
    if (res.writableEnded) return;
    // Keepalive comment first (always cheap; some proxies time out
    // streams that haven't sent bytes in 60s).
    res.write(': keepalive\n\n');
    // Snapshot too — covers app-mode / AFK / spend / pinned changes
    // we don't have a dedicated event for yet.
    write('status', deps.getStatus());
  }, SSE_TICK_MS);

  const cleanup = (): void => {
    clearInterval(tick);
    unsubNotif();
    deps.runner.off('status', onTaskStatus);
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/** Inline placeholder served at /mobile until the PWA shell lands.
 *  Confirms the auth + Tailscale path works end-to-end before we
 *  bundle the renderer in. */
function mobilePlaceholder(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Jarvis · mobile</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #04070b; color: #d8eefb;
               font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; }
  body { display: flex; flex-direction: column; align-items: center;
         justify-content: center; padding: 24px; text-align: center; gap: 18px; }
  h1 { margin: 0; font-size: 16px; letter-spacing: 0.32em; color: #00d4ff;
       text-shadow: 0 0 8px rgba(0, 212, 255, 0.55); }
  p { margin: 0; max-width: 320px; line-height: 1.5; color: #88a7bd; font-size: 12px; }
  .v { color: #4a6478; font-size: 10px; letter-spacing: 0.18em;
       text-transform: uppercase; }
</style>
</head>
<body>
  <h1>◢ JARVIS · MOBILE</h1>
  <p>Reachable. The PWA shell isn't installed yet — this is the placeholder.</p>
  <span class="v">v${escape(version)}</span>
</body>
</html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OAUTH_PAGE_STYLE = `
  body { font: 14px -apple-system, system-ui, sans-serif; background: #0e1116; color: #e8eaed; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 360px; padding: 32px; text-align: center; }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 500; }
  p { margin: 0 0 8px; color: #a8b0bb; }
  .ok { color: #6dd58c; }
  .err { color: #ff7b7b; }
`;

function successPage(provider: string): string {
  return `<!doctype html><html><head><title>Connected</title><style>${OAUTH_PAGE_STYLE}</style></head>
<body><div class="card">
  <h1 class="ok">${escape(provider)} connected</h1>
  <p>You can close this tab and return to Jarvis.</p>
</div>
<script>setTimeout(() => window.close(), 800);</script>
</body></html>`;
}

function errorPage(provider: string, message: string): string {
  return `<!doctype html><html><head><title>Couldn't connect</title><style>${OAUTH_PAGE_STYLE}</style></head>
<body><div class="card">
  <h1 class="err">Couldn't connect ${escape(provider)}</h1>
  <p>${escape(message)}</p>
  <p>You can close this tab and try again from Jarvis.</p>
</div></body></html>`;
}
