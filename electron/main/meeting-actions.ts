import { readFileSync } from 'node:fs';

import type { InboxItem } from '@shared/types';

import type { GoalStore } from './goals.js';
import type { InboxStore } from './inbox.js';
import { parseIntent } from './intent-router.js';
import type { ReminderStore } from './reminders.js';

/**
 * After a meeting-debrief task rewrites a transcript with the
 * structured `## Action items` section, extract those bullets and
 * surface them in the Inbox so the user actually sees what's
 * waiting. The transcript alone is read-only memory; the inbox
 * surfaces it as "do this".
 *
 * Items land under source='meeting-actions' via InboxStore's
 * external-items channel (same path workflows use). Each meeting's
 * actions REPLACE the previous bucket for that meeting key — re-
 * running the debrief skill doesn't pile up duplicates. Multiple
 * meetings can have actions live at the same time because we key
 * the bucket by source name (one bucket, all meetings) but key the
 * items themselves by `<meeting-id>:<action-index>` for stable
 * react keys + dedupe across debrief runs.
 *
 * Each item is an InboxItem with:
 *   - title:    "[owner] action — by when"
 *   - subtitle: "<meeting title> · <project?>"
 *   - url:      vscode://file/<absolute path>  (so click opens
 *               the transcript at the source of truth)
 *   - createdAt: timestamp the meeting finished
 *
 * The OWNER is preserved as-is from the markdown — when the skill
 * couldn't infer an owner it writes `[?]`. We don't try to filter
 * "your" actions vs others; the user can read the bracket and
 * decide. (A future enhancement could surface only [me] / [you] /
 * [<your name>] items, but that's locale + name-dependent.)
 */

export interface MeetingActionItem {
  /** Owner bracket from `[owner]`. `?` when the skill couldn't infer one. */
  owner: string;
  /** The action verb phrase, without the owner bracket or deadline. */
  action: string;
  /** The "— by when" tail if present, otherwise null. */
  due: string | null;
}

/** Strict-ish parse of the `## Action items` section. We look for a
 *  level-2 heading whose text starts with "Action item" (singular or
 *  plural, case-insensitive), then consume bullets until the next
 *  heading or EOF. Each bullet is `- [owner] action — by when`. The
 *  em-dash, en-dash, or " - " separator works — the skill's
 *  instructions specify em-dash but real LLM output drifts. */
export function extractMeetingActions(markdown: string): MeetingActionItem[] {
  const lines = markdown.split('\n');
  let inSection = false;
  const out: MeetingActionItem[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) {
      inSection = /^##\s+action items?\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    // Bullet markers: -, *, • all accepted.
    const m = /^[\s]*[-*•]\s+(.+)$/.exec(line);
    if (!m) continue;
    const body = m[1]!.trim();
    // Skip the placeholder "No action items." that the skill emits
    // when there's nothing to do.
    if (/^no\s+action\s+items?\.?$/i.test(body)) continue;
    const parsed = parseBullet(body);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Parse one bullet body: "[owner] action — by when". The owner
 *  bracket is required to count as an action item — without it
 *  we're probably looking at a different bulleted list that the
 *  skill mis-organised. */
function parseBullet(body: string): MeetingActionItem | null {
  const ownerMatch = /^\[([^\]]+)\]\s+(.+)$/.exec(body);
  if (!ownerMatch) return null;
  const owner = ownerMatch[1]!.trim();
  let rest = ownerMatch[2]!.trim();
  let due: string | null = null;
  // Split on em-dash, en-dash, or " - " — preserve everything after
  // as the deadline label. The skill's spec uses " — " but real LLM
  // outputs drift.
  const dueMatch = /\s+[—–-]\s+(.+)$/.exec(rest);
  if (dueMatch) {
    due = dueMatch[1]!.trim();
    rest = rest.slice(0, dueMatch.index).trim();
  }
  if (!rest) return null;
  return { owner, action: rest, due };
}

interface PushArgs {
  /** Markdown path on disk — used both for parsing and for the
   *  inbox item url so a click opens the source. */
  transcriptPath: string;
  /** Display title for the meeting (e.g. "Engineering standup"). */
  meetingTitle: string;
  /** Project slug when the recording was project-scoped. */
  project: string | null;
  /** When the meeting finished — drives `createdAt` for sort order. */
  finishedAt: number;
  /** Stable per-meeting id used to dedupe item ids across re-runs. */
  meetingKey: string;
  /** Reminder store — when an action item has a parseable deadline
   *  ("by Friday", "tomorrow 9am"), we mint a real reminder so the
   *  user gets a time-fired nudge instead of just a static inbox row. */
  reminders?: ReminderStore;
  /** Goal store — when an action item mentions an active goal's
   *  relatedKeywords, append a progress entry so the goal stays in
   *  sync with what the meeting concluded. */
  goals?: GoalStore;
}

interface ActionSideEffect {
  reminderCreated: boolean;
  goalsTouched: string[];
}

/**
 * Read the debrief'd transcript at `args.transcriptPath`, extract
 * action items, and push them to the inbox under
 * source='meeting-actions'. No-op (and logs) if the file can't be
 * read or no actions are present.
 *
 * Replaces the items for THIS meeting (keyed by meetingKey prefix)
 * but preserves items from other meetings — multiple recent
 * meetings can have live actions at the same time.
 */
export function pushMeetingActionsToInbox(
  inbox: InboxStore,
  args: PushArgs,
): void {
  let md: string;
  try {
    md = readFileSync(args.transcriptPath, 'utf8');
  } catch (err) {
    console.warn('[meeting-actions] could not read transcript:', err);
    return;
  }
  const actions = extractMeetingActions(md);
  if (actions.length === 0) {
    console.log(
      `[meeting-actions] no actions extracted from ${args.transcriptPath}`,
    );
    return;
  }

  // Preserve existing items from OTHER meetings — only replace this
  // meeting's. We do this by reading whatever the source currently
  // holds via getSourceItems() if available; otherwise fall back to
  // "this meeting's items only" which is the common case.
  const existing = readExistingMeetingActions(inbox).filter(
    (i) => !i.id.startsWith(`meeting-action-${args.meetingKey}:`),
  );

  // Pre-cache active goals so we keyword-match each action item
  // against them in O(actions * goals). Goals' relatedKeywords list
  // is short (≤ 8 each); cheap.
  const activeGoals = args.goals ? args.goals.listActive() : [];

  let reminderCount = 0;
  let goalLinkCount = 0;

  const fresh = actions.map((a, i): InboxItem => {
    const dueSuffix = a.due ? ` — ${a.due}` : '';
    const side = applyActionSideEffects(a, args, activeGoals);
    if (side.reminderCreated) reminderCount += 1;
    if (side.goalsTouched.length > 0) goalLinkCount += side.goalsTouched.length;

    const subtitleBits: string[] = [];
    subtitleBits.push(
      args.project
        ? `${args.meetingTitle} · ${args.project}`
        : args.meetingTitle,
    );
    if (side.reminderCreated) subtitleBits.push('⏰ reminder set');
    if (side.goalsTouched.length > 0) {
      subtitleBits.push(`◎ goal: ${side.goalsTouched.join(', ')}`);
    }

    return {
      id: `meeting-action-${args.meetingKey}:${i}`,
      source: 'meeting-actions',
      title: `[${a.owner}] ${a.action}${dueSuffix}`,
      subtitle: subtitleBits.join(' · '),
      url: `vscode://file${args.transcriptPath}`,
      createdAt: args.finishedAt,
    };
  });

  inbox.setExternalItems(
    'meeting-actions',
    'Meeting action items',
    [...existing, ...fresh].sort((a, b) => b.createdAt - a.createdAt),
  );
  console.log(
    `[meeting-actions] pushed ${fresh.length} item(s) from ${args.transcriptPath}` +
      (reminderCount > 0 ? ` · ${reminderCount} reminder(s)` : '') +
      (goalLinkCount > 0 ? ` · ${goalLinkCount} goal link(s)` : ''),
  );
}

/**
 * For one action item, try to (a) mint a real reminder if the `due`
 * phrase parses to a time, and (b) append a progress entry on each
 * active goal whose relatedKeywords appear in the action text.
 *
 * Both ops are best-effort — a parse miss or unknown goal id silently
 * skips; we never block the inbox push on a side effect failing.
 *
 * Owner-aware reminders: items whose owner bracket is `me`, `i`,
 * `you`, or `?` count as actions the user owns. Other owners (e.g.
 * "[Alice]") are skipped for reminders — those are someone else's
 * action items that the user should know about but not be nagged
 * about. Goal-progress logging still happens regardless of owner —
 * a coworker shipping something against a goal still counts as
 * progress.
 */
function applyActionSideEffects(
  action: MeetingActionItem,
  args: PushArgs,
  goals: ReturnType<GoalStore['listActive']>,
): ActionSideEffect {
  const out: ActionSideEffect = { reminderCreated: false, goalsTouched: [] };

  if (args.reminders && action.due && isSelfOwner(action.owner)) {
    const phrase = `${action.action} by ${action.due}`;
    try {
      const parsed = parseIntent(phrase);
      if (parsed.kind === 'reminder' && parsed.fireAt > Date.now()) {
        args.reminders.create({
          body: `${action.action} (from ${args.meetingTitle})`,
          mode: 'reminder',
          fireAt: parsed.fireAt,
        });
        out.reminderCreated = true;
      }
    } catch (err) {
      console.warn(
        '[meeting-actions] could not parse due into reminder:',
        action.due,
        err,
      );
    }
  }

  if (args.goals && goals.length > 0) {
    const haystack = action.action.toLowerCase();
    for (const g of goals) {
      const hit = g.relatedKeywords.find(
        (k) => k && haystack.includes(k.toLowerCase()),
      );
      if (!hit) continue;
      args.goals.appendProgress(g.id, {
        note: `Meeting (${args.meetingTitle}): ${action.action}${action.due ? ` — by ${action.due}` : ''}`,
        source: 'meeting',
        url: `vscode://file${args.transcriptPath}`,
      });
      // Track by the short title so the inbox subtitle is readable;
      // ids would dominate the visual.
      const shortTitle =
        g.title.length > 24 ? `${g.title.slice(0, 23)}…` : g.title;
      out.goalsTouched.push(shortTitle);
    }
  }

  return out;
}

/** True if the bracketed owner reads as the user. The skill writes
 *  `[?]` when it can't infer; we treat that as "probably mine" so
 *  the reminder still fires — better to over-remind than miss. */
function isSelfOwner(owner: string): boolean {
  const norm = owner.trim().toLowerCase();
  return (
    norm === '?' ||
    norm === 'me' ||
    norm === 'i' ||
    norm === 'you' ||
    norm === 'self'
  );
}

/** Pull the current meeting-actions items so we can preserve those
 *  belonging to other meetings while replacing the current
 *  meeting's. InboxStore doesn't have a public per-source getter,
 *  so we filter the full list. Cheap — these arrays are tiny. */
function readExistingMeetingActions(inbox: InboxStore): InboxItem[] {
  try {
    return inbox.list().filter((i) => i.source === 'meeting-actions');
  } catch {
    return [];
  }
}
