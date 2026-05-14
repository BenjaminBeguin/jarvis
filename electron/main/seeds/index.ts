/**
 * Built-in skill catalogue. Each entry is a (name, body) pair where `body`
 * is a complete SKILL.md file (YAML frontmatter + system prompt). Adding a
 * skill: drop a file under `./skills/<name>.ts` with `export default \`...\``
 * and add it to the list below.
 *
 * Skills here are seeded only when missing — user edits to ~/.jarvis/skills/
 * are preserved.
 */

import brainstorm from './skills/brainstorm.js';
import commitHelper from './skills/commit-helper.js';
import dailyBrief from './skills/daily-brief.js';
import meetingDebrief from './skills/meeting-debrief.js';
import prAddressComments from './skills/pr-address-comments.js';
import prReviewQueue from './skills/pr-review-queue.js';
import send from './skills/send.js';
import skillAuthor from './skills/skill-author.js';
import status from './skills/status.js';
import ticketToPr from './skills/ticket-to-pr.js';

export interface BuiltinSkill {
  name: string;
  body: string;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: 'brainstorm', body: brainstorm },
  { name: 'commit-helper', body: commitHelper },
  { name: 'daily-brief', body: dailyBrief },
  { name: 'meeting-debrief', body: meetingDebrief },
  { name: 'pr-address-comments', body: prAddressComments },
  { name: 'pr-review-queue', body: prReviewQueue },
  { name: 'send', body: send },
  { name: 'skill-author', body: skillAuthor },
  { name: 'status', body: status },
  { name: 'ticket-to-pr', body: ticketToPr },
];

export { SAMPLE_MCP_CONFIG, SAMPLE_PROJECTS } from './samples.js';
