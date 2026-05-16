import { shell } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Local mirror of MCP's `CallToolResult` shape — the Agent SDK's `tool`
 * handler signature wants this type, but the upstream
 * `@modelcontextprotocol/sdk` package isn't in our deps. The fields
 * we use are structurally compatible.
 */
interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

import { nextCronFire } from '@shared/cron';

import type { ActivityStore } from './activity-store.js';
import type { ProjectMemoryStore } from './project-memory.js';
import type { ProjectStore } from './projects.js';
import type { ReminderStore } from './reminders.js';
import type { UserContextStore } from './user-context.js';

/**
 * The "jarvis" MCP server — runs in-process alongside the agent SDK, no
 * subprocess, no permissions, no auth. Lets every task call into Jarvis
 * itself: pop notifications, log activity, schedule reminders, read the
 * active project, list recent notes / meetings.
 *
 * Always loaded for every task (TaskRunner injects it). Skills with
 * tight `allowed-tools` can scope or exclude individual tools by name
 * (e.g. `mcp__jarvis__notify`).
 *
 * Tool naming convention: snake_case action names (`notify`,
 * `log_activity`). The Agent SDK exposes them to the model as
 * `mcp__jarvis__<name>`. Returns follow MCP's CallToolResult shape —
 * single text block summarising what happened, machine-readable JSON
 * when the agent will keep using the value (project lookup, lists).
 */

export interface JarvisMcpDeps {
  notify: (title: string, body: string) => void;
  activity: ActivityStore;
  reminders: ReminderStore;
  projects: ProjectStore;
  projectMemory: ProjectMemoryStore;
  userContext: UserContextStore;
  jarvisRoot: string;
  /** Flip the global pause flag — same effect as the tray / Settings
   *  toggle. Routines + scheduled-action reminders skip while true. */
  setPaused: (value: boolean) => void;
  isPaused: () => boolean;
}

const ok = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
});
const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const err = (msg: string): CallToolResult => ({
  content: [{ type: 'text', text: `error: ${msg}` }],
  isError: true,
});

export function createJarvisMcp(
  deps: JarvisMcpDeps,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'jarvis',
    version: '0.1.0',
    tools: [
      tool(
        'notify',
        'Show a macOS notification to the user. Use for short signals: "task complete", "5 min until standup", "PR ready". Body should fit one glance — under 80 chars.',
        {
          title: z.string().min(1).max(60),
          body: z.string().min(1).max(200),
        },
        async (args) => {
          deps.notify(args.title, args.body);
          return ok(`notified: ${args.title}`);
        },
      ),

      tool(
        'log_activity',
        'Append a row to the Activity feed (Settings → Activity). Use for non-conversational side effects you want the user to see later: "ran cleanup", "checked Slack mentions". `kind` is a short dotted id ("recap.daily", "scan.slack"); `label` is the human one-liner.',
        {
          kind: z.string().min(1).max(60),
          label: z.string().min(1).max(160),
          detail: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => {
          deps.activity.record({
            kind: args.kind,
            label: args.label,
            detail: args.detail,
          });
          return ok(`logged: ${args.kind}`);
        },
      ),

      tool(
        'create_reminder',
        'Schedule a future reminder. Mode "reminder" fires a notification only (no agent run); mode "scheduled" launches a fresh task to carry out the body. `fireAt` is ms epoch — pass an absolute timestamp computed from the current time. For recurring reminders, also pass `cron` (5-field POSIX cron, e.g. "0 9 * * 1" for every Monday 9am); the reminder reschedules itself on each fire instead of being one-shot.',
        {
          body: z.string().min(1),
          mode: z.enum(['reminder', 'scheduled']),
          fireAt: z.number().int().positive(),
          cron: z.string().optional(),
        },
        async (args) => {
          if (args.fireAt < Date.now() - 60_000) {
            return err('fireAt is in the past');
          }
          if (args.cron && nextCronFire(args.cron, Date.now()) == null) {
            return err(
              `invalid cron expression "${args.cron}" — needs 5 fields like "0 9 * * 1"`,
            );
          }
          const r = deps.reminders.create({
            body: args.body,
            mode: args.mode,
            fireAt: args.fireAt,
            cron: args.cron,
          });
          const suffix = args.cron ? ` (recurring · ${args.cron})` : '';
          return ok(
            `reminder ${r.id} scheduled for ${new Date(r.fireAt).toISOString()}${suffix}`,
          );
        },
      ),

      tool(
        'open_url',
        'Open a URL in the user\'s default browser. Use for "here\'s the PR you asked about" / "opened the docs". Only http(s) URLs.',
        { url: z.string().url() },
        async (args) => {
          if (!/^https?:\/\//i.test(args.url)) {
            return err('url must be http(s)');
          }
          await shell.openExternal(args.url);
          return ok(`opened ${args.url}`);
        },
      ),

      tool(
        'get_active_project',
        'Return the user\'s currently active project scope: { name, aliases, path?, repo? } — or null when no scope is set. Useful to default file paths / repo arguments to the right place.',
        {},
        async () => {
          const name = deps.userContext.getActiveProject();
          if (!name) return json(null);
          const def = deps.projects.resolve(name);
          return json(def ?? { name });
        },
      ),

      tool(
        'list_recent_meetings',
        'List recent meeting transcripts under ~/.jarvis/meetings/. Optionally scope to a project. Returns up to `limit` items, newest first, with file path + mtime.',
        {
          project: z.string().optional(),
          limit: z.number().int().positive().max(50).optional(),
        },
        async (args) => {
          const dir = args.project
            ? join(deps.jarvisRoot, 'meetings', slugify(args.project))
            : join(deps.jarvisRoot, 'meetings');
          if (!existsSync(dir)) return json([]);
          let entries: import('node:fs').Dirent[];
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
          const files = entries
            .filter((e) => e.isFile() && e.name.endsWith('.md'))
            .map((e) => {
              const full = join(dir, e.name);
              const stat = statSync(full);
              return {
                filename: e.name,
                path: full,
                mtimeMs: stat.mtimeMs,
              };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, args.limit ?? 10);
          return json(files);
        },
      ),

      tool(
        'list_recent_notes',
        'List recent note files under ~/.jarvis/notes/. Optionally scope to a project. Same shape as list_recent_meetings.',
        {
          project: z.string().optional(),
          limit: z.number().int().positive().max(50).optional(),
        },
        async (args) => {
          const dir = args.project
            ? join(deps.jarvisRoot, 'notes', slugify(args.project))
            : join(deps.jarvisRoot, 'notes');
          if (!existsSync(dir)) return json([]);
          let entries: import('node:fs').Dirent[];
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
          const files = entries
            .filter((e) => e.isFile() && e.name.endsWith('.md'))
            .map((e) => {
              const full = join(dir, e.name);
              const stat = statSync(full);
              return {
                filename: e.name,
                path: full,
                mtimeMs: stat.mtimeMs,
              };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, args.limit ?? 10);
          return json(files);
        },
      ),

      tool(
        'read_project_memory',
        'Read a markdown memory file from ~/.jarvis/projects/<project>/memory/. Omit `file` to list available files. Use to load long-term project context the agent should incorporate.',
        {
          project: z.string().min(1),
          file: z.string().optional(),
        },
        async (args) => {
          try {
            const result = deps.projectMemory.read(args.project, args.file);
            return json(result);
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
        },
      ),

      tool(
        'write_project_memory',
        'Append content to a project memory file under ~/.jarvis/projects/<project>/memory/<file>. Creates the file if missing. Use to persist what the agent learned during a task ("Luca prefers slack DMs over email").',
        {
          project: z.string().min(1),
          file: z.string().min(1),
          content: z.string().min(1),
        },
        async (args) => {
          try {
            deps.projectMemory.append(args.project, args.file, args.content);
            return ok(`appended to ${args.project}/${args.file}`);
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
        },
      ),

      tool(
        'set_paused',
        'Toggle Jarvis global pause. When paused, routines + scheduled-action reminders skip firing — anything that would auto-spawn a Claude turn waits until resumed. User-initiated palette/voice/Telegram dispatches still work. Use sparingly; this is the "off switch" the user reaches for when they want quiet (sleeping, in a meeting, traveling).',
        {
          paused: z.boolean(),
        },
        async (args) => {
          deps.setPaused(args.paused);
          return ok(args.paused ? 'jarvis paused' : 'jarvis resumed');
        },
      ),

      tool(
        'get_paused',
        'Read the current global pause state. Useful before deciding whether to schedule a routine fire vs. tell the user it would be skipped.',
        {},
        async () => json({ paused: deps.isPaused() }),
      ),
    ],
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
