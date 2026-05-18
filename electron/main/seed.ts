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

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content, 'utf8');
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
  for (const wf of BUILTIN_WORKFLOWS) {
    writeIfMissing(
      join(workflowsRoot, `${wf.id}.json`),
      JSON.stringify(wf, null, 2) + '\n',
    );
  }
}
