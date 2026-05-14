import { spawn } from 'node:child_process';

import type { McpConfigStore } from './mcp-config.js';

export interface McpToolSummary {
  name: string;
  description?: string;
  /** Best-effort JSON schema for inputs; may be unknown. */
  inputSchema?: unknown;
}

export interface ProbeResult {
  ok: boolean;
  tools?: McpToolSummary[];
  /** Total wall time the probe took, in ms. */
  durationMs?: number;
  message?: string;
}

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Spawn the MCP server briefly, run the JSON-RPC handshake
 * (initialize → notifications/initialized → tools/list), and return the
 * tools array. Only supports stdio servers — claude.ai HTTP connectors
 * require auth we don't have locally.
 *
 * First probe of an npx-based server can take 20-30s (npm install).
 * Subsequent probes are usually 1-3s. Anything past PROBE_TIMEOUT_MS we
 * give up so the UI doesn't hang.
 */
export async function probeMcpTools(
  mcp: McpConfigStore,
  id: string,
): Promise<ProbeResult> {
  const cfg = mcp.resolve([id])[id];
  if (!cfg) return { ok: false, message: `No mcp.json entry for "${id}".` };
  if (cfg.type !== 'stdio') {
    return {
      ok: false,
      message: `Only stdio servers can be probed; ${id} is ${cfg.type}.`,
    };
  }

  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (r: ProbeResult) => {
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
    let initSent = false;
    let initializedNotified = false;

    const send = (msg: Record<string, unknown>) => {
      try {
        proc.stdin.write(JSON.stringify(msg) + '\n');
      } catch {
        // pipe closed; will surface via 'close'
      }
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // MCP messages are newline-delimited JSON.
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error?.message) {
          finish({ ok: false, message: `server error: ${msg.error.message}` });
          return;
        }
        // id:1 = initialize response → fire initialized + tools/list
        if (msg.id === 1) {
          if (!initializedNotified) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            initializedNotified = true;
          }
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
          continue;
        }
        // id:2 = tools/list response
        if (msg.id === 2) {
          const result = msg.result as { tools?: McpToolSummary[] } | undefined;
          const tools = Array.isArray(result?.tools) ? result.tools : [];
          finish({
            ok: true,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
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
          message: stderr.trim() || `process exited (code ${code ?? 'null'}) before tools/list.`,
        });
      }
    });

    // Kick off the handshake.
    const startHandshake = () => {
      if (initSent) return;
      initSent = true;
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'jarvis-probe', version: '1.0.0' },
        },
      });
    };
    // Give the server a tick to set up its stdin reader.
    setTimeout(startHandshake, 50);

    setTimeout(
      () => finish({ ok: false, message: `timeout after ${PROBE_TIMEOUT_MS / 1000}s` }),
      PROBE_TIMEOUT_MS,
    );
  });
}
