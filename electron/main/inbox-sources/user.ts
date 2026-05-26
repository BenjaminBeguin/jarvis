import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { InboxItem } from '@shared/types';

import { InboxDismissalStore } from '../inbox-dismissals.js';
import type { InboxSource } from '../inbox.js';

/**
 * User-authored inbox sources. Reads every `*.json` file under
 * `~/.jarvis/inbox/` and surfaces its items in the unified inbox.
 *
 * Format (one of):
 *
 *   1. A bare array of InboxItem-shaped objects:
 *      [ { "id": "...", "title": "...", ... } ]
 *
 *   2. A wrapper with source + label metadata + items:
 *      {
 *        "source": "slack-mentions",
 *        "label": "Slack mentions",
 *        "items": [ ... ]
 *      }
 *
 * Either way, items are normalised to InboxItem and forwarded to the
 * inbox. The wrapper form is preferred — it controls the section header
 * + dedup namespace.
 *
 * How to populate these files: a skill writes them. The skill is fired
 * by a routine on a schedule. Example flow for "show me Slack mentions
 * every 10 min":
 *
 *   1. Author / use a `slack-inbox` skill that writes
 *      `~/.jarvis/inbox/slack.json` after pulling MCP data.
 *   2. Add a routine: `{ cron: "*\/10 * * * *", skillId: "slack-inbox" }`.
 *   3. The inbox picks up new items on its next 5-min auto-refresh.
 *
 * One source ⇒ one file. The file name (sans .json) becomes the default
 * source id; the wrapper's `source` field overrides.
 */

const INBOX_DIR = join(homedir(), '.jarvis', 'inbox');

/**
 * Source names owned by built-in workflows (linear-inbox-sync,
 * slack-inbox-sync, calendar-today-sync) and by autopilot-internal
 * node types (draft-output writes to 'autopilot-drafts' and any
 * 'autopilot-*' bucket the user picks). Their inbox-write /
 * draft-output nodes feed InboxStore.setExternalItems() directly.
 * If a JSON file lands here with one of these source names — stale
 * from a prior install, or a user who manually wrote one — we skip
 * it so it can't shadow the canonical workflow/autopilot section.
 */
const RESERVED_SOURCES = new Set(['linear', 'slack', 'calendar']);
const RESERVED_PREFIXES = ['autopilot-'];
let loggedReserved = false;

interface InboxFileWrapper {
  source?: string;
  label?: string;
  items: unknown[];
  /** Optional companion array: inbox item ids the skill / workflow that
   *  wrote this file inferred are DONE (PR merged, message sent, etc.).
   *  Each tick of the fetch passes these through InboxDismissalStore so
   *  they drop off the unified inbox without the user having to click
   *  through. Used by the work-awareness loop today. */
  dismissals?: unknown[];
}

function isWrapper(v: unknown): v is InboxFileWrapper {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as InboxFileWrapper).items)
  );
}

/** Per-source, per-id memory of which dismissals we've already applied
 *  during this process lifetime. Without this, the source's fetch would
 *  re-call dismiss on every refresh — harmless (the dismissal store is
 *  idempotent) but noisy in the logs. Keyed by `<filename>:<id>` so two
 *  files with overlapping ids don't trample each other. */
const appliedDismissals = new Set<string>();
const dismissalStore = new InboxDismissalStore();

function isItem(v: unknown): v is InboxItem {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.title === 'string' &&
    typeof r.createdAt === 'number'
  );
}

export const userInboxSource: InboxSource = {
  name: 'user',
  label: 'User scenarios',
  async fetch(): Promise<InboxItem[]> {
    // Lazy mkdir on first run — so when a skill tries to write here,
    // the directory exists.
    mkdirSync(INBOX_DIR, { recursive: true });
    if (!existsSync(INBOX_DIR)) return [];

    const out: InboxItem[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(INBOX_DIR, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (entry.name.startsWith('.')) continue;
      const path = join(INBOX_DIR, entry.name);
      const sourceFromName = entry.name.replace(/\.json$/, '');
      // Defense-in-depth: even if the migration's delete step failed,
      // never let a JSON file shadow a built-in JS source.
      const reservedPrefix = RESERVED_PREFIXES.some((p) =>
        sourceFromName.startsWith(p),
      );
      if (RESERVED_SOURCES.has(sourceFromName) || reservedPrefix) {
        if (!loggedReserved) {
          console.warn(
            `[inbox/user] ignoring ${entry.name} — '${sourceFromName}' is now a built-in JS source. Delete the file to silence this.`,
          );
          loggedReserved = true;
        }
        continue;
      }

      let raw: string;
      let mtimeMs = Date.now();
      try {
        raw = readFileSync(path, 'utf8');
        mtimeMs = statSync(path).mtimeMs;
      } catch (err) {
        console.warn(`Inbox: failed to read ${entry.name}:`, err);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(`Inbox: ${entry.name} is not valid JSON:`, err);
        continue;
      }

      let items: unknown[];
      let source = sourceFromName;
      let dismissals: unknown[] = [];
      if (isWrapper(parsed)) {
        items = parsed.items;
        if (typeof parsed.source === 'string' && parsed.source) {
          source = parsed.source;
        }
        if (Array.isArray(parsed.dismissals)) {
          dismissals = parsed.dismissals;
        }
      } else if (Array.isArray(parsed)) {
        items = parsed;
      } else {
        console.warn(
          `Inbox: ${entry.name} must be an array or {source,label,items}`,
        );
        continue;
      }

      // Apply dismissals before items are returned. The auto-dismiss
      // path: a skill (work-awareness today) writes a wrapper file
      // with a `dismissals: [<id>, ...]` array of inbox item ids it
      // inferred are done based on recent activity. We pass each
      // through InboxDismissalStore so the unified Inbox filters them
      // out automatically. Long snooze (8h) — not "forever" — so an
      // incorrectly-dismissed item naturally reappears later if the
      // user actually still needs it.
      const DISMISS_MS = 8 * 60 * 60 * 1000;
      for (const raw of dismissals) {
        if (typeof raw !== 'string' || !raw) continue;
        const key = `${entry.name}:${raw}`;
        if (appliedDismissals.has(key)) continue;
        appliedDismissals.add(key);
        try {
          dismissalStore.dismiss(raw, DISMISS_MS);
        } catch (err) {
          console.warn(
            `[inbox/user] failed to apply dismissal ${raw}:`,
            err,
          );
        }
      }

      for (const raw of items) {
        if (!isItem(raw)) continue;
        // Stamp the source so the UI groups them under the right
        // section header, even if the skill forgot to set it.
        out.push({ ...raw, source: raw.source || source });
        // Fall back to file mtime when the skill didn't set createdAt
        // (it's required by the type guard above, but cheap insurance).
        const last = out[out.length - 1]!;
        if (!last.createdAt) last.createdAt = mtimeMs;
        // Normalize URL-navigation actions that were mistakenly emitted
        // as `kind: 'task'` (the default). The pattern: a skill emits
        // `action: { label: "Open in X", skillId: 'send', prompt: 'Open
        // <URL>' }` to add a custom-labeled button, but `kind: 'task'`
        // (the default) means the button spawns a Claude turn just to
        // open a URL — wasteful + slow. Rewriting to `kind: 'open-url'`
        // here means future regenerations of the same file get the
        // right behavior even if the skill itself didn't get the memo.
        const a = last.action;
        if (
          a &&
          (a.kind === undefined || a.kind === 'task') &&
          typeof a.label === 'string' &&
          /^(open|view)\b/i.test(a.label) &&
          last.url
        ) {
          last.action = {
            label: a.label,
            kind: 'open-url',
            url: a.url ?? last.url,
          };
        }
      }
    }
    return out;
  },
};
