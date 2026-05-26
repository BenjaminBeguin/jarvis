import type { Goal } from '@shared/types';

import type { Module, ModuleContext } from './types.js';

// Captured in onLoad so onUnload — which doesn't receive ctx — can
// still call unregister. Module is a singleton; safe to hold one ref.
let savedCtx: ModuleContext | null = null;

/**
 * The Goals module — multi-day commitments ("ship X by Friday") that
 * don't fit reminders (too long) or routines (not recurring).
 *
 *   /goal <title> [by <date>]  — create a new active goal. The body
 *     after the title is treated as the rationale + acceptance criteria.
 *     Use "by tomorrow", "by Friday", "by 2026-06-15" or just "by next
 *     week" to set a deadline; the free-text intent router parses the
 *     phrase, and the part before/after it becomes the title/body.
 *   /goals  — open the inbox filtered to goals (they're inbox items).
 *   /goal-update <id> <note>  — append a manual progress entry. The
 *     daily goal-progress skill also appends entries automatically based
 *     on PR / meeting / Slack activity matching the goal's keywords.
 *   /goal-done <id>  — mark a goal done (removes it from the active
 *     inbox surface; the activity log retains the record).
 *
 * The context provider surfaces active goals with their nearest deadline
 * + days-since-last-progress so any Claude turn answering "what should
 * I focus on?" has the persistent commitments in mind.
 */
export const goalsModule: Module = {
  id: 'goals',
  name: 'Goals',
  description:
    'Persistent multi-day commitments. Goals surface in the Inbox alongside everything else; a daily skill auto-appends progress from PRs, meetings, and Slack signal matching the goal\'s keywords.',
  version: '1.0.0',
  memory: [
    {
      label: 'Goals (title, deadline, progress log)',
      location: '~/.jarvis/goals.json',
      kind: 'file',
      access: 'read-write',
      notes:
        'One entry per goal. Active goals surface in the Inbox; done/abandoned stay in the file for history.',
    },
  ],
  onLoad(ctx) {
    savedCtx = ctx;
    ctx.registerContextProvider({
      name: 'goals',
      build: () => buildGoalsContext(ctx.listActiveGoals()),
    });
  },
  onUnload() {
    savedCtx?.unregisterContextProvider('goals');
    savedCtx = null;
  },
  intents: [
    {
      id: 'create',
      prefix: '/goal',
      label: 'Add goal',
      description:
        'Add a persistent commitment, e.g. "/goal ship the mobile PWA by Friday"',
      placeholder: 'ship the mobile PWA by Friday',
      verbalTriggers: [
        'add goal',
        'new goal',
        'create goal',
        'create a goal',
        'i want to',
        'my goal is',
      ],
      handler: (input, ctx) => {
        const body = input.trim();
        if (!body) {
          return 'Need a title. Try "/goal ship the mobile PWA by Friday" or "/goal land design v2 by 2026-06-15".';
        }
        // Try to parse a deadline phrase out of the body using the
        // shared free-text router. Falls back to open-ended if no
        // time phrase is found.
        let title = body;
        let deadline: number | null = null;
        const parsed = ctx.parseFreeTextIntent(body);
        if (parsed.kind === 'reminder') {
          deadline = parsed.fireAt;
          title = parsed.body;
        }
        // Split title from rationale: first sentence/line is the title,
        // anything after a newline or " — " is the body.
        const splitMatch = /^([^\n—]+?)\s*(?:[—\n]\s*(.+))?$/s.exec(title);
        const cleanTitle = (splitMatch?.[1] ?? title).trim();
        const rationale = (splitMatch?.[2] ?? '').trim();
        const g = ctx.createGoal({
          title: cleanTitle,
          body: rationale,
          deadline,
          relatedKeywords: deriveKeywords(cleanTitle),
        });
        const when =
          deadline != null
            ? new Date(deadline).toLocaleDateString(undefined, {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
              })
            : 'open-ended';
        ctx.notify(`Goal · ${when}`, g.title);
        return `Goal set · ${when}`;
      },
    },
    {
      id: 'list',
      prefix: '/goals',
      label: 'Open goals',
      description: 'Browse active goals (inbox view filtered to goals)',
      verbalTriggers: ['show goals', 'list goals', 'my goals', 'open goals'],
      handler: (_input, ctx) => {
        ctx.broadcast('shell:navigate', { tab: 'inbox' });
        return 'Opening goals';
      },
    },
    {
      id: 'update',
      prefix: '/goal-update',
      label: 'Log goal progress',
      description: 'Append a progress note. Usage: /goal-update <id> <note>',
      placeholder: '<id> shipped the auth refactor',
      handler: (input, ctx) => {
        const body = input.trim();
        const sep = body.indexOf(' ');
        if (sep <= 0) {
          return 'Usage: /goal-update <id> <note>. Run /goals to find an id.';
        }
        const id = body.slice(0, sep).trim();
        const note = body.slice(sep + 1).trim();
        if (!note) return 'Need a progress note after the id.';
        const updated = ctx.appendGoalProgress(id, {
          note,
          source: 'user',
        });
        if (!updated) return `No goal with id "${id}".`;
        return `Logged · ${updated.progressLog.length} entries · ${updated.title.slice(0, 60)}`;
      },
    },
    {
      id: 'done',
      prefix: '/goal-done',
      label: 'Mark goal done',
      description: 'Mark a goal as done. Usage: /goal-done <id>',
      placeholder: '<id>',
      handler: (input, ctx) => {
        const id = input.trim();
        if (!id) return 'Usage: /goal-done <id>. Run /goals to find an id.';
        const next = ctx.setGoalStatus(id, 'done');
        if (!next) return `No goal with id "${id}".`;
        ctx.notify('Goal done', next.title);
        return `Done · ${next.title.slice(0, 80)}`;
      },
    },
    {
      id: 'abandon',
      prefix: '/goal-abandon',
      label: 'Abandon goal',
      description: 'Mark a goal as abandoned. Usage: /goal-abandon <id>',
      placeholder: '<id>',
      handler: (input, ctx) => {
        const id = input.trim();
        if (!id) return 'Usage: /goal-abandon <id>. Run /goals to find an id.';
        const next = ctx.setGoalStatus(id, 'abandoned');
        if (!next) return `No goal with id "${id}".`;
        return `Abandoned · ${next.title.slice(0, 80)}`;
      },
    },
  ],
};

/**
 * Active goals condensed for the ambient context block. Returns null
 * when nothing's active so the provider stays silent. Sorted by
 * deadline (soonest first); open-ended goals sort to the bottom.
 * Caps at 5 to keep the block compact.
 */
function buildGoalsContext(active: Goal[]): string | null {
  if (active.length === 0) return null;
  const now = Date.now();
  const top = active.slice(0, 5);
  const lines = top.map((g) => {
    const last = g.progressLog[g.progressLog.length - 1] ?? null;
    const daysLeft =
      g.deadline != null
        ? Math.max(0, Math.ceil((g.deadline - now) / (24 * 60 * 60 * 1000)))
        : null;
    const lastBit = last
      ? ` · last progress ${formatAgo(now - last.at)}`
      : ' · no progress yet';
    const whenBit =
      daysLeft != null
        ? daysLeft === 0
          ? 'due today'
          : daysLeft === 1
            ? 'due tomorrow'
            : `${daysLeft}d left`
        : 'open-ended';
    const title = g.title.length > 70 ? `${g.title.slice(0, 70)}…` : g.title;
    return `  - [${g.id}] ${title} (${whenBit}${lastBit})`;
  });
  return `- Active goals:\n${lines.join('\n')}`;
}

function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Cheap keyword extraction from a goal title. Strips stopwords + short
 * tokens; keeps verbs/nouns the goal-progress skill can match against
 * PR titles, commit messages, meeting transcripts. The user can edit
 * the resulting list later — this is just a sensible default.
 */
function deriveKeywords(title: string): string[] {
  const stop = new Set([
    'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in', 'is',
    'it', 'me', 'my', 'of', 'on', 'or', 'so', 'than', 'that', 'the', 'this',
    'to', 'with', 'we', 'us', 'you', 'your', 'should', 'would', 'could',
    'want', 'ship', 'build', 'make', 'do', 'get', 'have', 'has', 'will',
  ]);
  return Array.from(
    new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3 && !stop.has(w)),
    ),
  ).slice(0, 8);
}
