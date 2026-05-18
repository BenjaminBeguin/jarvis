import { fromPromise } from 'xstate';

import { invokeMcpTool } from '../mcp-invoke.js';
import type { NodeHandlerInput } from './types.js';

/**
 * MCP-call node. Invokes a single tool on any MCP server Jarvis
 * knows about — stdio entries from mcp.json, connector-managed stdio
 * entries like GitHub, AND in-process SDK servers managed by the
 * OAuth connectors (Google Gmail / Calendar, Slack, Notion, Linear).
 * Used when a workflow needs structured output from a provider — e.g.
 * `mcp__calendar__list_events`, `mcp__github__list_issues`,
 * `mcp__linear__issueCreate`, or a custom in-house MCP.
 *
 * For multi-account integrations the per-account suffix is included
 * in the mcp id (e.g. `calendar-foo@x.com`, `slack-T0ABC`). Use the
 * exact id from Settings → MCP Servers / Connected Accounts.
 *
 * Params:
 *   {
 *     mcp: string          // server id (e.g. "github", "calendar-me@x.com")
 *     tool: string         // tool name as the MCP exposes it (without
 *                          //   the mcp__<server>__ prefix)
 *     args?: object        // forwarded to the tool's input
 *     parse?: 'text' | 'json' | 'raw'  // default 'text'
 *                          // 'text'  → joins all text content blocks
 *                          // 'json'  → parses each text block as JSON
 *                          //           and returns an array
 *                          // 'raw'   → returns the raw `content` array
 *                          //           (mix of {type:'text', text} etc.)
 *   }
 *
 * Output: depends on `parse` (default the joined text). Throws if the
 *   server flags isError or the call itself fails.
 */

interface McpCallParams {
  mcp: string;
  tool: string;
  args?: Record<string, unknown>;
  parse?: 'text' | 'json' | 'raw';
}

interface TextBlock {
  type: 'text';
  text: string;
}

function isTextBlock(b: unknown): b is TextBlock {
  return (
    !!b &&
    typeof b === 'object' &&
    (b as { type?: unknown }).type === 'text' &&
    typeof (b as { text?: unknown }).text === 'string'
  );
}

export const mcpCallNode = fromPromise<
  unknown,
  NodeHandlerInput<McpCallParams>
>(async ({ input }) => {
  const { params, ctx } = input;
  if (!params.mcp || typeof params.mcp !== 'string') {
    throw new Error('mcp-call: params.mcp is required');
  }
  if (!params.tool || typeof params.tool !== 'string') {
    throw new Error('mcp-call: params.tool is required');
  }
  const result = await invokeMcpTool(
    ctx.mcp,
    params.mcp,
    params.tool,
    params.args ?? {},
  );
  if (!result.ok) {
    throw new Error(
      `mcp-call: ${params.mcp}.${params.tool} failed — ${result.message ?? 'unknown'}`,
    );
  }
  if (result.isError) {
    const text = Array.isArray(result.content)
      ? (result.content as unknown[])
          .filter(isTextBlock)
          .map((b) => b.text)
          .join('\n')
      : 'unknown server-side error';
    throw new Error(`mcp-call: ${params.mcp}.${params.tool} → ${text}`);
  }
  const parse = params.parse ?? 'text';
  if (parse === 'raw') return result.content ?? [];
  if (!Array.isArray(result.content)) return result.content;
  const blocks = (result.content as unknown[]).filter(isTextBlock);
  if (parse === 'json') {
    return blocks.map((b) => {
      try {
        return JSON.parse(b.text);
      } catch {
        return b.text;
      }
    });
  }
  return blocks.map((b) => b.text).join('\n');
});
