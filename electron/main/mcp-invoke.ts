import { spawn } from 'node:child_process';

import type { McpConfigStore, McpServerConfig } from './mcp-config.js';

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
 * Invoke a single tool on any Jarvis-known MCP server. Stdio servers
 * are spawned, handshaked, and torn down per call (used by the
 * playground UI for tool exploration). SDK-managed in-process servers
 * — Google Gmail / Calendar, Slack, Notion, Linear from OAuth — are
 * invoked directly by reaching into their registered tool map, no
 * subprocess involved.
 *
 * Returns the raw `content` array so downstream code (workflow nodes,
 * playground UI) can post-process however it wants.
 */
export async function invokeMcpTool(
  mcp: McpConfigStore,
  id: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<InvokeResult> {
  const cfg = mcp.resolve([id])[id];
  if (!cfg) return { ok: false, message: `No mcp.json entry for "${id}".` };
  if (cfg.type === 'sdk') return invokeSdkTool(cfg, toolName, args);
  if (cfg.type !== 'stdio') {
    return {
      ok: false,
      message: `Only stdio and sdk servers can be invoked; ${id} is ${cfg.type}.`,
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

/**
 * SDK-managed in-process MCP servers (Google / Slack / Notion / Linear
 * from OAuth) keep their registered tools on `instance._registeredTools`
 * as `{ name, description, inputSchema, handler }`. The handler is the
 * async function we passed to `tool(...)` in the connector factory; it
 * returns `{ content, isError? }` directly.
 *
 * We reach in rather than spinning an in-memory transport because the
 * @modelcontextprotocol/sdk isn't a direct dep here — the Agent SDK
 * bundles it. The internals are stable enough (the field name comes
 * from the upstream MCP server class) that this is a reasonable
 * tradeoff vs. duplicating the dependency.
 */
async function invokeSdkTool(
  cfg: Extract<McpServerConfig, { type: 'sdk' }>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<InvokeResult> {
  const started = Date.now();
  const instance = cfg.instance as unknown as {
    _registeredTools?: Record<
      string,
      {
        enabled?: boolean;
        handler: (
          args: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<{ content?: unknown; isError?: boolean }>;
      }
    >;
  };
  const registry = instance._registeredTools;
  if (!registry) {
    return {
      ok: false,
      message:
        'SDK MCP instance is missing _registeredTools — Agent SDK upgrade likely broke direct invocation.',
      durationMs: Date.now() - started,
    };
  }
  const tool = registry[toolName];
  if (!tool) {
    return {
      ok: false,
      message: `Tool "${toolName}" not found on this SDK MCP server.`,
      durationMs: Date.now() - started,
    };
  }
  if (tool.enabled === false) {
    return {
      ok: false,
      message: `Tool "${toolName}" is disabled.`,
      durationMs: Date.now() - started,
    };
  }
  try {
    const result = await tool.handler(args, {});
    return {
      ok: true,
      content: result.content,
      isError: !!result.isError,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
