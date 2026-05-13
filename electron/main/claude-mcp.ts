import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ClaudeMcpEntry } from '@shared/types';

const execFileAsync = promisify(execFile);

/**
 * Shell out to `claude mcp list` and parse the human-readable output. We
 * don't trust a stable --json flag across CLI versions, so we tolerate
 * either: line-based ("<name>: <target> - <status>") or whatever falls
 * through to a permissive regex.
 *
 * The names get normalized for grouping: a claude.ai connector arrives as
 * "claude.ai Slack" — we strip the prefix and tag source='claude.ai' so
 * the renderer can match by short name ("slack", "gmail", …) regardless
 * of whether the user is using a claude.ai connector or a stdio MCP they
 * registered via `claude mcp add`.
 */
export async function listClaudeMcps(
  binPath: string,
  timeoutMs = 8_000,
): Promise<ClaudeMcpEntry[]> {
  if (!binPath) return [];
  try {
    const { stdout } = await execFileAsync(binPath, ['mcp', 'list'], {
      timeout: timeoutMs,
    });
    return parseClaudeMcpList(stdout);
  } catch {
    return [];
  }
}

export function parseClaudeMcpList(out: string): ClaudeMcpEntry[] {
  const lines = out.split(/\r?\n/);
  const result: ClaudeMcpEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Checking|^MCP servers|^No MCP/i.test(line)) continue;
    const m = /^(.+?):\s+(.+?)\s+-\s+(.+)$/.exec(line);
    if (!m) continue;
    const fullName = m[1]!;
    const target = m[2]!;
    const statusRaw = m[3]!;
    const status: ClaudeMcpEntry['status'] = /Connected/i.test(statusRaw)
      ? 'connected'
      : /Needs authentication/i.test(statusRaw)
        ? 'needs-auth'
        : /Failed/i.test(statusRaw)
          ? 'failed'
          : 'unknown';
    let source: ClaudeMcpEntry['source'] = 'user';
    let name = fullName;
    if (fullName.startsWith('claude.ai ')) {
      source = 'claude.ai';
      name = fullName.slice('claude.ai '.length);
    } else if (fullName.startsWith('plugin:')) {
      source = 'plugin';
      // "plugin:github:github" → "github"
      const parts = fullName.split(':');
      name = parts[parts.length - 1] ?? fullName;
    }
    result.push({ name: name.trim(), target, status, source, fullName });
  }
  return result;
}
