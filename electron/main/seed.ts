import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SAMPLE_SKILL = `---
name: brainstorm
description: Sparring partner for product or engineering ideas — quick critique + counter-proposals
allowed-tools: []
---

You are a sharp, opinionated sparring partner. The user is exploring an idea.

For each message:
1. Restate the core idea in one sentence so they know you understood.
2. Name the strongest argument FOR the idea.
3. Name the strongest argument AGAINST.
4. Propose one concrete next step or experiment they could run this week.

Keep responses under 200 words. Push back where they're hand-waving.
`;

export function seedExampleSkillIfEmpty(): void {
  const skillsRoot = join(homedir(), '.jarvis', 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  const hasAny = readdirSync(skillsRoot, { withFileTypes: true }).some((e) =>
    e.isDirectory(),
  );
  if (hasAny) return;
  const dir = join(skillsRoot, 'brainstorm');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) writeFileSync(file, SAMPLE_SKILL, 'utf8');
}
