import { shell } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

import type { DraftStatus, InboxItem } from '@shared/types';

import type { ActivityStore } from './activity-store.js';
import type { getCostBreakdown as getCostBreakdownFn } from './db.js';
import { dispatchDraftSend } from './draft-send.js';
import type { DraftsStore } from './drafts-store.js';
import type { InboxStore } from './inbox.js';
import type { McpConfigStore } from './mcp-config.js';
import type { ProjectMemoryStore } from './project-memory.js';
import type { ProjectStore } from './projects.js';
import type { ReminderStore } from './reminders.js';
import type { UserContextStore } from './user-context.js';
import type { WorkflowRunner } from './workflow-runner.js';
import type { WorkflowStore } from './workflow-store.js';

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
  /** Read aggregated spend over the last `windowDays`. Same shape the
   *  Settings → Spend tab renders. */
  getCostBreakdown: typeof getCostBreakdownFn;
  /** JSON-defined pipelines under ~/.jarvis/workflows/. Used by the
   *  list/run tools so agents can fire workflows the same way the
   *  palette does. */
  workflows: WorkflowStore;
  workflowRunner: WorkflowRunner;
  /** Inbox aggregator — used by add_to_inbox to trigger an immediate
   *  refresh after appending to a JSON bucket so items appear without
   *  waiting for the next auto-refresh tick. */
  inbox: InboxStore;
  /** AI drafts queue. Backs the list/get/discard/revert/update/send
   *  tools so the agent can act on drafts the user would otherwise
   *  click through manually in the Drafts tab. */
  drafts: DraftsStore;
  /** MCP config store — needed by send_draft to resolve the channel
   *  MCP (gmail, slack, …) that a draft's sendAction targets. */
  mcp: McpConfigStore;
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
        'Append a row to the Activity feed (Settings → Activity). Use for non-conversational side effects you want the user to see later: "ran cleanup", "checked Slack mentions". `kind` is a short dotted id ("recap.daily", "scan.slack"); `label` is the human one-liner. NOTE: Activity is an audit log, not the user\'s triage view — for "things the user should look at" use add_to_inbox instead.',
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
        'add_to_inbox',
        'Add an item to the user\'s Inbox triage view. Use when the user says "keep an eye on this", "remind me to check X", "add to my watch list" — anything that means "I want to see this later when I scan my queue." Items appear under a custom section identified by `source` (e.g. "watch", "follow-up", "questions") and persist across restarts via `~/.jarvis/inbox/<source>.json`. Each `id` is dedup-stable: calling twice with the same `(source, id)` replaces the earlier entry. To remove: call with the same id and the user will dismiss it from the UI. Use `url` for an external link (opens in browser via the auto-added Open button). For more elaborate actions, see the optional `action` field. Prefer this over log_activity when the user should see the item in their daily triage queue.',
        {
          source: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'source must be lowercase letters / digits / dashes (e.g. "watch", "follow-up")').optional(),
          id: z.string().min(1).max(120),
          title: z.string().min(1).max(200),
          subtitle: z.string().max(200).optional(),
          url: z.string().url().optional(),
          project: z.string().max(60).optional(),
          why: z.string().max(200).optional(),
          action: z.object({
            label: z.string().min(1).max(40),
            kind: z.enum(['task', 'open-url']).optional(),
            skillId: z.string().optional(),
            prompt: z.string().optional(),
            url: z.string().url().optional(),
          }).optional(),
        },
        async (args) => {
          // 'watch' is the default bucket name — matches the conventional
          // "keep an eye on" UX. The user can override via `source`.
          const source = args.source ?? 'watch';
          // RESERVED_SOURCES in inbox-sources/user.ts: linear / slack /
          // calendar are owned by built-in workflows; writing JSON to
          // those names is silently dropped. Catch it here with a
          // friendlier error.
          if (['linear', 'slack', 'calendar'].includes(source)) {
            return err(
              `source "${source}" is reserved for a built-in workflow — pick a different name like "watch" or "follow-up"`,
            );
          }
          const inboxDir = join(deps.jarvisRoot, 'inbox');
          mkdirSync(inboxDir, { recursive: true });
          const file = join(inboxDir, `${source}.json`);

          interface Wrapper { source: string; label: string; items: InboxItem[] }
          let wrapper: Wrapper = {
            source,
            label: source.charAt(0).toUpperCase() + source.slice(1).replace(/-/g, ' '),
            items: [],
          };
          if (existsSync(file)) {
            try {
              const parsed = JSON.parse(readFileSync(file, 'utf8'));
              if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
                wrapper = { ...wrapper, ...parsed, items: parsed.items as InboxItem[] };
              } else if (Array.isArray(parsed)) {
                wrapper.items = parsed as InboxItem[];
              }
            } catch (e) {
              return err(`failed to parse existing ${source}.json: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          const item: InboxItem = {
            id: args.id,
            source,
            title: args.title,
            createdAt: Date.now(),
            ...(args.subtitle ? { subtitle: args.subtitle } : {}),
            ...(args.url ? { url: args.url } : {}),
            ...(args.project ? { project: args.project } : {}),
            ...(args.why ? { why: args.why } : {}),
            ...(args.action ? { action: args.action } : {}),
          };
          const i = wrapper.items.findIndex((it) => it.id === item.id);
          if (i >= 0) {
            // Preserve original createdAt — replacing the same id should
            // not jump the item back to the top of "newest first".
            item.createdAt = wrapper.items[i]!.createdAt;
            wrapper.items[i] = item;
          } else {
            wrapper.items.unshift(item);
          }

          try {
            writeFileSync(file, JSON.stringify(wrapper, null, 2));
          } catch (e) {
            return err(`failed to write ${source}.json: ${e instanceof Error ? e.message : String(e)}`);
          }

          // Pull immediately so the item shows up in the UI without
          // waiting for the 5-min auto-refresh tick.
          void deps.inbox.refresh();
          return ok(`added to inbox: ${source}/${args.id}`);
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

      tool(
        'get_cost_breakdown',
        'Read Jarvis spend over a window. Use for building weekly cost digests, alerting on budget drift, or just answering "what are we spending money on lately?" Returns total + bySkill + byOrigin + byRoutine + byProject + byDay + pool stats — same shape the Settings → Spend tab renders. windowDays clamps to [1, 90]; default 7 if omitted.',
        {
          windowDays: z.number().int().min(1).max(90).optional(),
        },
        async (args) => {
          try {
            const n = args.windowDays ?? 7;
            return json(deps.getCostBreakdown(n));
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
        },
      ),

      tool(
        'list_workflows',
        'List every workflow loaded from ~/.jarvis/workflows/. Returns { id, name, description?, enabled, trigger, nodeCount } per entry. Use to discover what workflows exist before calling run_workflow.',
        {},
        async () => {
          const list = deps.workflows.list().map((w) => ({
            id: w.id,
            name: w.name,
            description: w.description,
            enabled: w.enabled,
            trigger: w.trigger,
            nodeCount: w.pipeline.length,
          }));
          return json(list);
        },
      ),

      tool(
        'run_workflow',
        'Fire a workflow manually by id. Attributes the run to `manual` (same as the palette /wf, "Run now" button). Returns { runId, status } — the run continues in the background. Use list_workflows first to discover ids.',
        {
          id: z.string().min(1),
        },
        async (args) => {
          const def = deps.workflows.get(args.id);
          if (!def) return err(`Workflow not found: ${args.id}`);
          try {
            const run = deps.workflowRunner.run(def, 'manual');
            deps.activity.record({
              kind: 'workflow.run',
              label: `Workflow fired (mcp) · ${def.name}`,
              detail: {
                workflowId: def.id,
                runId: run.id,
                trigger: 'manual',
              },
            });
            return json({ runId: run.id, status: run.status });
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
        },
      ),

      // ──── Drafts ────────────────────────────────────────────────
      // The Drafts tab is where AI-generated outputs (Gmail replies,
      // Slack DMs, PR comments) wait for human review. These tools
      // let the agent act on them the way the user would click-act
      // through the UI — list / send / discard / revert / update /
      // refine. Mirrors `src/renderer/views/Drafts.tsx`.

      tool(
        'list_drafts',
        'List AI drafts waiting for the user (or filter by status / source / channel). Each draft has an `actions` array — the LLM-chosen Send/Archive/Forward/etc. options the user picks from in the UI. Use this to find a draft id before calling get_draft, discard_draft, or send_draft. Default `limit` 50.',
        {
          status: z
            .union([
              z.enum(['pending', 'sending', 'sent', 'failed', 'discarded']),
              z.array(
                z.enum(['pending', 'sending', 'sent', 'failed', 'discarded']),
              ),
            ])
            .optional(),
          source: z.string().optional(),
          channel: z.string().optional(),
          limit: z.number().int().positive().max(200).optional(),
        },
        async (args) => {
          const list = deps.drafts.list({
            status: args.status as DraftStatus | DraftStatus[] | undefined,
            source: args.source,
            channel: args.channel,
            limit: args.limit ?? 50,
          });
          // Trim the result for agent consumption — full bodies and
          // sendAction args bloat the context without adding signal.
          // The agent calls get_draft for the full row when needed.
          return json(
            list.map((d) => ({
              id: d.id,
              source: d.source,
              channel: d.channel,
              status: d.status,
              title: d.title,
              contextSummary: d.contextSummary,
              why: d.why,
              actions: d.actions.map((a) => ({
                id: a.id,
                label: a.label,
                primary: a.primary ?? false,
                requiresBody: a.requiresBody ?? true,
              })),
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
            })),
          );
        },
      ),

      tool(
        'get_draft',
        'Fetch one draft by id, including the editable body, full original context, and the LLM-chosen actions[] with their dispatch templates. Use after list_drafts to inspect a specific draft before sending or discarding.',
        { id: z.string().min(1) },
        async (args) => {
          const draft = deps.drafts.get(args.id);
          if (!draft) return err(`Draft not found: ${args.id}`);
          return json(draft);
        },
      ),

      tool(
        'discard_draft',
        'Discard one draft by id. Marks the row as `discarded` — it stops appearing in the Drafts tab\'s default Pending filter. Idempotent; sending a second time is a no-op. Use when the user says "drop that one" / "I\'ll handle it myself" / "ignore the Asana draft".',
        { id: z.string().min(1) },
        async (args) => {
          const ok2 = deps.drafts.discard(args.id);
          return ok2
            ? ok(`discarded: ${args.id}`)
            : err(`Draft not found: ${args.id}`);
        },
      ),

      tool(
        'discard_drafts',
        'BULK: discard every draft matching the filter. Status defaults to ["pending","failed"] — `sent` and `discarded` rows are never re-discarded. Use when the user says "discard all my drafts" / "clear the queue" / "drop all the Gmail ones". `confirm: true` is REQUIRED to prevent accidental fires from hallucinated calls; without it this tool errors with the count it WOULD discard, so the agent can echo it back to the user for explicit approval.',
        {
          status: z
            .union([
              z.enum(['pending', 'sending', 'sent', 'failed', 'discarded']),
              z.array(
                z.enum(['pending', 'sending', 'sent', 'failed', 'discarded']),
              ),
            ])
            .optional(),
          source: z.string().optional(),
          channel: z.string().optional(),
          confirm: z.boolean().optional(),
        },
        async (args) => {
          const filter = {
            status: args.status as DraftStatus | DraftStatus[] | undefined,
            source: args.source,
            channel: args.channel,
          };
          if (args.confirm !== true) {
            const wouldDiscard = deps.drafts.list({ ...filter, limit: 1000 })
              .filter((d) => d.status !== 'sent' && d.status !== 'discarded')
              .length;
            return err(
              `confirm:true required for bulk discard. Would discard ${wouldDiscard} draft(s) matching the filter. Echo the count back to the user, get explicit approval, then call again with confirm:true.`,
            );
          }
          const n = deps.drafts.bulkDiscard(filter);
          deps.activity.record({
            kind: 'drafts.bulk-discard',
            label: `Bulk-discarded ${n} draft(s) via agent tool`,
            detail: { filter, count: n },
          });
          return ok(`discarded ${n} draft${n === 1 ? '' : 's'}`);
        },
      ),

      tool(
        'revert_draft',
        'Reset a draft\'s editable body to the AI\'s original first draft. Use when the user says "undo my edits" / "start over with what you wrote". No effect on sent/discarded drafts.',
        { id: z.string().min(1) },
        async (args) => {
          const draft = deps.drafts.revert(args.id);
          if (!draft) return err(`Draft not found: ${args.id}`);
          return ok(`reverted: ${args.id}`);
        },
      ),

      tool(
        'update_draft_body',
        'Replace a draft\'s editable body. Use when the user says "make the reply say X" / "change the tone to formal". The next send picks up the new body. Sent/discarded drafts are immutable — this is a no-op on those.',
        {
          id: z.string().min(1),
          body: z.string(),
        },
        async (args) => {
          const draft = deps.drafts.updateBody(args.id, args.body);
          if (!draft) return err(`Draft not found: ${args.id}`);
          return ok(`updated body: ${args.id}`);
        },
      ),

      tool(
        'send_draft',
        'Dispatch one of a draft\'s actions (the LLM-chosen Send / Archive / Forward / Star options). Omit `actionId` to fire the primary action (or the first). Marks the draft as sent on success, failed on error. Returns the post-dispatch draft + result message. Use when the user says "send draft <id>" / "approve the reply to Alice" / "archive that Asana notification" — after confirming WHICH draft (call list_drafts first if uncertain).',
        {
          id: z.string().min(1),
          actionId: z.string().optional(),
        },
        async (args) => {
          const result = await dispatchDraftSend(
            deps.drafts,
            deps.mcp,
            args.id,
            args.actionId,
          );
          if (!result.ok) {
            return err(result.message ?? 'Send failed.');
          }
          return json({
            ok: true,
            draftId: args.id,
            status: result.draft?.status,
            message: result.message,
          });
        },
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
