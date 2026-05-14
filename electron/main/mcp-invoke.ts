import { spawn } from 'node:child_process';

import type { McpConfigStore } from './mcp-config.js';

export interface InvokeResult {
  ok: boolean;
  /** Raw MCP `tools/call` result content (array of content blocks). */
  content?: unknown;
  /** Whether the server flagged the result as an error (isError: true). */
  isError?: boolean;
  durationMs?: number;
  message?: string;
}

const INVOKE_TIMEOUT_MS = 60_000;

/**
 * Spawn the MCP server, complete the JSON-RPC handshake, invoke a single
 * tool, and return the result. The playground UI uses this to let users
 * try a tool with concrete inputs and see what comes back — useful for
 * verifying credentials work and for exploring what each tool actually
 * returns before writing a skill that depends on it.
 */
export async function invokeMcpTool(
  mcp: McpConfigStore,
  id: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<InvokeResult> {
  const cfg = mcp.resolve([id])[id];
  if (!cfg) return { ok: false, message: `No mcp.json entry for "${id}".` };
  if (cfg.type !== 'stdio') {
    return {
      ok: false,
      message: `Only stdio servers can be invoked; ${id} is ${cfg.type}.`,
    };
  }

  const started = Date.now();
  return new Promise<InvokeResult>((resolve) => {
    let settled = false;
    const finish = (r: InvokeResult) => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({ ...r, durationMs: Date.now() - started });
    };

    const proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      finish({ ok: false, message: `spawn failed: ${err.message}` });
    });

    let buf = '';
    let stderr = '';

    const send = (msg: Record<string, unknown>) => {
      try {
        proc.stdin.write(JSON.stringify(msg) + '\n');
      } catch {
        // pipe closed; surfaces via 'close'
      }
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: {
          id?: number;
          result?: { content?: unknown; isError?: boolean };
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error?.message) {
          finish({ ok: false, message: `server error: ${msg.error.message}` });
          return;
        }
        // id:1 = initialize response → fire initialized + tools/call
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
          });
          continue;
        }
        // id:2 = tools/call response
        if (msg.id === 2) {
          finish({
            ok: true,
            content: msg.result?.content,
            isError: !!msg.result?.isError,
          });
          return;
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });

    proc.on('close', (code) => {
      if (!settled) {
        finish({
          ok: false,
          message: stderr.trim() || `process exited (code ${code ?? 'null'}) before tools/call.`,
        });
      }
    });

    // Kick off the handshake.
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'jarvis-playground', version: '1.0.0' },
        },
      });
    }, 50);

    setTimeout(
      () => finish({ ok: false, message: `timeout after ${INVOKE_TIMEOUT_MS / 1000}s` }),
      INVOKE_TIMEOUT_MS,
    );
  });
}
