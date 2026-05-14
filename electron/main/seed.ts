import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

import { BUILTIN_SKILLS, SAMPLE_MCP_CONFIG, SAMPLE_PROJECTS } from './seeds/index.js';

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
  mkdirSync(skillsRoot, { recursive: true });

  writeIfMissing(join(root, 'mcp.json.example'), SAMPLE_MCP_CONFIG);
  writeIfMissing(join(root, 'projects.json.example'), SAMPLE_PROJECTS);

  // Each built-in skill seeds only if missing. New built-ins added in later
  // versions show up automatically; user-authored skills are never touched.
  for (const { name, body } of BUILTIN_SKILLS) {
    writeSkill(skillsRoot, name, body);
  }
}
