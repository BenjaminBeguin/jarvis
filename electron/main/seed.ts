import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

import {
  BUILTIN_SKILLS,
  SAMPLE_INBOX_PRIORITIES,
  SAMPLE_MCP_CONFIG,
  SAMPLE_PROJECTS,
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
  // Old slack workflow had no `validate` clause on the http-fetch,
  // so { ok: false } responses went silently through and zero items
  // got written. New seed includes the validate expression — also
  // matches the previous `'5m'` cron-shorthand default (now bumped
  // to business hours). Either fingerprint authorises a rewrite.
  'slack-inbox-sync': (def) => {
    const fetch = def.pipeline.find((n) => n.type === 'http-fetch');
    if (fetch) {
      const p = fetch.params ?? {};
      if (typeof p['validate'] !== 'string') return true;
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
 * Seed a built-in skill on first launch. If the file exists but its YAML
 * frontmatter no longer parses (almost always a bug in a prior seed string,
 * not an intentional user edit), overwrite it with the current known-good
 * body. We never touch user-authored skills.
 */
function writeSkill(skillsRoot: string, name: string, body: string): void {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  if (!existsSync(path)) {
    writeFileSync(path, body, 'utf8');
    return;
  }
  try {
    matter(readFileSync(path, 'utf8'));
  } catch {
    writeFileSync(path, body, 'utf8');
  }
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

  // Each built-in skill seeds only if missing. New built-ins added in later
  // versions show up automatically; user-authored skills are never touched.
  for (const { name, body } of BUILTIN_SKILLS) {
    writeSkill(skillsRoot, name, body);
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
