import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

import {
  BUILTIN_SKILLS,
  SAMPLE_INBOX_PRIORITIES,
  SAMPLE_MCP_CONFIG,
  SAMPLE_PROJECTS,
  SAMPLE_TRIAGE_POLICY,
} from './seeds/index.js';
import { BUILTIN_WORKFLOWS } from './seeds/workflows/index.js';
import type { WorkflowDef } from '@shared/types';

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content, 'utf8');
}

/**
 * Per-built-in detectors that recognise a previous, known-broken
 * seed shape on disk and authorize replacement. Each entry returns
 * true when the on-disk JSON looks like the "old seed we shipped" —
 * i.e. the user almost certainly hasn't customized it, just kept
 * the bug. When true, the seeder overwrites with the latest body.
 *
 * Conservative by design: we only replace shapes we can fingerprint
 * confidently. Anything we can't recognise is treated as "user-
 * customized" and left alone.
 */
const WORKFLOW_STALE_DETECTORS: Record<
  string,
  (def: WorkflowDef) => boolean
> = {
  // Old calendar workflow used AppleScript with a pad2(n) helper.
  // Calendar workflow lineage:
  //   1. AppleScript with `on pad2(n)` helper (-2741 on newer macOS).
  //   2. First-gen JXA with `_and: [{ startDate: … }]` (-1701).
  //   3. Second-gen JXA with single-property whose() + fallback loop
  //      — still depends on macOS Calendar.app automation access,
  //      which most users haven't granted to osascript.
  //   4. Current: mcp-call to the Google Calendar OAuth MCP. No
  //      Calendar.app dependency at all. Detect any earlier shape
  //      (any osascript step) and rewrite.
  'calendar-today-sync': (def) => {
    return def.pipeline.some((n) => n.type === 'osascript');
  },
  // Slack workflow versions:
  //   v1: cron '5m', no validate clause                  → migrate
  //   v2: cron '*/15 9-18 * * 1-5', validate present    → migrate
  //   v3: noise-v2 marker (drops bots + caps age)       → migrate if older
  //   v4: noise-v3 marker (mentions:me search modifier) → migrate if older
  //   v5: noise-v4 marker (had a hardcoded in:#jarvis
  //       default — rolled back, "Jarvis" is a sidebar
  //       section name, not a channel, and Slack's
  //       public API can't enumerate section members)
  //   v6: noise-v5 marker (default query is DMs +
  //       mentions only; users add channel branches
  //       manually).
  // Latest sentinel is noise-v5. NOTE: the rewrite overwrites
  // user-edited query bodies — if the user appended OR-branches
  // for tracked channels, those get wiped on the next launch.
  // Acceptable for now; longer-term we want a per-user "tracked
  // channels" list separate from the seed.
  'slack-inbox-sync': (def) => {
    const fetch = def.pipeline.find((n) => n.type === 'http-fetch');
    if (fetch) {
      const p = fetch.params ?? {};
      if (typeof p['validate'] !== 'string') return true;
    }
    const transform = def.pipeline.find((n) => n.type === 'transform');
    if (transform) {
      const fn = (transform.params as { fn?: string })?.fn;
      if (typeof fn === 'string' && !fn.includes('noise-v5')) return true;
    }
    return (
      isUntouchedShorthandCron(def, '5m') ||
      isUntouchedShorthandCron(def, '*/15 9-18 * * 1-5')
    );
  },
  // Linear workflow shipped with `every: '5m'` (24/7), then
  // `*/15 9-18 * * 1-5` (hardcoded business hours). Migrate both to
  // `*/15 {businessHours}` so the user's working-hours pref drives.
  'linear-inbox-sync': (def) =>
    isUntouchedShorthandCron(def, '5m') ||
    isUntouchedShorthandCron(def, '*/15 9-18 * * 1-5'),
  // Inbox curate shipped `every: '10m'` then `*/15 9-18 * * 1-5`.
  'inbox-curate-sync': (def) =>
    isUntouchedShorthandCron(def, '10m') ||
    isUntouchedShorthandCron(def, '*/15 9-18 * * 1-5'),
  // Slack DM autopilot pre-Drafts-store ended in batch-prompt-output
  // (accept = positive feedback, no message sent). The new shape
  // ends in draft-store-write → drafts land in the Drafts tab and
  // Accept actually sends. Detect the old terminal node and rewrite.
  'autopilot-slack-dm-ack': (def) => {
    const last = def.pipeline[def.pipeline.length - 1];
    return last?.type === 'batch-prompt-output';
  },
  // PR autopilot scenarios pre-Drafts-store also ended in
  // batch-prompt-output. Same migration: rewrite to the new shape
  // that ends in draft-store-write so drafts land in the Drafts tab
  // and Send posts via gh api.
  'autopilot-pr-comments-on-mine': (def) => {
    const last = def.pipeline[def.pipeline.length - 1];
    return last?.type === 'batch-prompt-output';
  },
  'autopilot-pr-review-non-team': (def) => {
    const last = def.pipeline[def.pipeline.length - 1];
    return last?.type === 'batch-prompt-output';
  },
};

/**
 * True when the on-disk workflow's cron `every` exactly matches the
 * given shorthand — meaning the user hasn't touched the schedule
 * since first launch and we can confidently bump it to the latest
 * seeded default.
 */
function isUntouchedShorthandCron(def: WorkflowDef, shorthand: string): boolean {
  return (
    def.trigger.kind === 'cron' && def.trigger.every.trim() === shorthand
  );
}

/**
 * Replace `<workflowsRoot>/<id>.json` with the latest seed body when
 * the on-disk shape matches a fingerprinted "old seed" we know is
 * buggy. Quietly skips files the user has customized past the
 * fingerprint — and any built-in without a detector.
 */
function migrateWorkflowIfStale(workflowsRoot: string, wf: WorkflowDef): void {
  const detector = WORKFLOW_STALE_DETECTORS[wf.id];
  if (!detector) return;
  const path = join(workflowsRoot, `${wf.id}.json`);
  if (!existsSync(path)) return;
  let parsed: WorkflowDef;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as WorkflowDef;
  } catch {
    return;
  }
  if (!detector(parsed)) return;
  writeFileSync(path, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  console.info(`[seed] migrated stale workflow seed: ${wf.id}`);
}

/**
 * Per-built-in skill detectors that recognise a previous broken shape
 * on disk and authorize replacement with the latest body. Conservative:
 * a detector must fingerprint something we KNOW we shipped wrong, not
 * "the user might have customized this." Matching = overwrite.
 */
const SKILL_BODY_DETECTORS: Record<string, (body: string) => boolean> = {
  // gmail-triage v1 told the model to surface archive-worthy messages
  // as drafts whose BODY was "(suggest archive — reason)". The Drafts
  // UI's Send button then mailed that body to the original sender as
  // a reply. v2 introduces an explicit intent='archive' + modify_labels
  // sendAction; v3 generalizes to actions[] per draft. Detect any
  // pre-actions[] shape and rewrite.
  'gmail-triage': (body) =>
    body.includes('(suggest archive — reason)') ||
    body.includes("'(suggest archive — Substack newsletter)'") ||
    body.includes("the '(suggest archive — reason)' line") ||
    // v2 (intent-based) → migrate to v3 (actions[])
    (body.includes('"intent": "reply"') && !body.includes('"actions":')) ||
    (body.includes('"intent": "archive"') && !body.includes('"actions":')),
  // slack-dm-ack v1/v2 used { intent, sendAction } shape. v3 emits
  // actions[]. Detect the older shape by the absence of "actions":
  // in the OUTPUT PROTOCOL section while still mentioning sendAction.
  'slack-dm-ack': (body) =>
    body.includes('"sendAction":') &&
    !body.includes('"actions":') &&
    body.includes('slack-dm-ack'),
  // pr-comments-triage v1 used a top-level sendAction. v2 emits
  // actions[] with a single 'reply' action.
  'pr-comments-triage': (body) =>
    body.includes('"sendAction":') &&
    !body.includes('"actions":') &&
    body.includes('pulls/<num>/comments/<comment-id>/replies'),
  // pr-review-triage v1 used top-level sendAction. v2 emits actions[]
  // with a single 'submit' action.
  'pr-review-triage': (body) =>
    body.includes('"sendAction":') &&
    !body.includes('"actions":') &&
    body.includes('pulls/<num>/reviews'),
};

/**
 * Seed a built-in skill on first launch. If the file exists but its YAML
 * frontmatter no longer parses (almost always a bug in a prior seed string,
 * not an intentional user edit), overwrite it with the current known-good
 * body. We never touch user-authored skills — unless a per-skill detector
 * matches a known-broken shape we shipped (see SKILL_BODY_DETECTORS).
 */
function writeSkill(skillsRoot: string, name: string, body: string): void {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  if (!existsSync(path)) {
    writeFileSync(path, body, 'utf8');
    return;
  }
  // Body-level migration for known-broken seeded skills.
  const detector = SKILL_BODY_DETECTORS[name];
  if (detector) {
    try {
      const existing = readFileSync(path, 'utf8');
      if (detector(existing)) {
        writeFileSync(path, body, 'utf8');
        console.info(`[seed] migrated stale skill seed: ${name}`);
        return;
      }
    } catch {
      // fall through to frontmatter check
    }
  }
  try {
    matter(readFileSync(path, 'utf8'));
  } catch {
    writeFileSync(path, body, 'utf8');
  }
}

/**
 * Per-skill frontmatter patch table. Each entry: a skill id → list of
 * (key, value) pairs to inject into the YAML frontmatter if missing.
 * Body is preserved verbatim. Used for surgical migrations — e.g.
 * adding `model: claude-haiku-4-5` to /status to speed up the
 * read-only digest path — without overwriting whatever the user has
 * tweaked in the prompt body.
 */
const SKILL_FRONTMATTER_PATCHES: Record<
  string,
  Array<{ key: string; value: string }>
> = {
  // Status digest is read-only; Haiku is ~2-3× faster than Sonnet
  // for this kind of summarization and quality is indistinguishable
  // for the shape of output the skill produces.
  status: [{ key: 'model', value: 'claude-haiku-4-5-20251001' }],
};

function patchSkillFrontmatter(skillsRoot: string, skillId: string): void {
  const patches = SKILL_FRONTMATTER_PATCHES[skillId];
  if (!patches || patches.length === 0) return;
  const path = join(skillsRoot, skillId, 'SKILL.md');
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch {
    return; // bad frontmatter; writeSkill's fallback handles this
  }
  const fm = parsed.data as Record<string, unknown>;
  let changed = false;
  for (const { key, value } of patches) {
    if (!(key in fm)) {
      fm[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  const next = matter.stringify(parsed.content, fm);
  writeFileSync(path, next, 'utf8');
  console.info(`[seed] patched ${skillId} frontmatter: ${patches.map((p) => p.key).join(', ')}`);
}

export function seedDefaultsIfEmpty(): void {
  const root = join(homedir(), '.jarvis');
  const skillsRoot = join(root, 'skills');
  const workflowsRoot = join(root, 'workflows');
  mkdirSync(skillsRoot, { recursive: true });
  mkdirSync(workflowsRoot, { recursive: true });

  writeIfMissing(join(root, 'mcp.json.example'), SAMPLE_MCP_CONFIG);
  writeIfMissing(join(root, 'projects.json.example'), SAMPLE_PROJECTS);
  // Smart-inbox calibration: a real file (not .example) — the
  // inbox-curate skill reads it on every refresh, and /inbox-calibrate
  // appends to it. Seeded once with placeholder bullets; the user
  // edits in place.
  writeIfMissing(join(root, 'inbox-priorities.md'), SAMPLE_INBOX_PRIORITIES);
  // Triage policy: read by every channel-specific triage skill
  // (gmail-triage today). Sub-sectioned by channel + shared sections
  // for people / defaults / tone. Seeded once with placeholders; the
  // user edits and the next workflow tick reflects the changes.
  writeIfMissing(join(root, 'triage-policy.md'), SAMPLE_TRIAGE_POLICY);

  // Each built-in skill seeds only if missing. New built-ins added in later
  // versions show up automatically; user-authored skills are never touched.
  for (const { name, body } of BUILTIN_SKILLS) {
    writeSkill(skillsRoot, name, body);
  }

  // Surgical frontmatter patches for existing user files. Lets us
  // ship a "switch /status to Haiku" without overwriting whatever
  // the user has changed in the body.
  for (const skillId of Object.keys(SKILL_FRONTMATTER_PATCHES)) {
    patchSkillFrontmatter(skillsRoot, skillId);
  }

  // Same model for workflows: seed if the file is missing; never
  // overwrite a user edit. New built-in workflows show up in later
  // releases automatically.
  //
  // Exception: a handful of built-ins shipped with bugs the user
  // can't realistically have customized around (broken AppleScript,
  // missing validate clause). For those, a per-id fingerprint
  // detector authorises a one-shot rewrite — see
  // WORKFLOW_STALE_DETECTORS above.
  for (const wf of BUILTIN_WORKFLOWS) {
    const path = join(workflowsRoot, `${wf.id}.json`);
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify(wf, null, 2) + '\n', 'utf8');
      continue;
    }
    migrateWorkflowIfStale(workflowsRoot, wf);
  }
}
