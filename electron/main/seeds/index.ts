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
import calendarToday from './skills/calendar-today.js';
import commitHelper from './skills/commit-helper.js';
import costRecap from './skills/cost-recap.js';
import dailyBrief from './skills/daily-brief.js';
import dailyRecap from './skills/daily-recap.js';
import inboxCalibrate from './skills/inbox-calibrate.js';
import inboxCurate from './skills/inbox-curate.js';
import linearInbox from './skills/linear-inbox.js';
import meetingDebrief from './skills/meeting-debrief.js';
import memoryTrim from './skills/memory-trim.js';
import prAddressComments from './skills/pr-address-comments.js';
import prReviewQueue from './skills/pr-review-queue.js';
import send from './skills/send.js';
import skillAuthor from './skills/skill-author.js';
import slackInbox from './skills/slack-inbox.js';
import status from './skills/status.js';
import ticketToPr from './skills/ticket-to-pr.js';
import todayFocus from './skills/today-focus.js';
import weeklyRetro from './skills/weekly-retro.js';
import workflowAuthor from './skills/workflow-author.js';

export interface BuiltinSkill {
  name: string;
  body: string;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: 'brainstorm', body: brainstorm },
  { name: 'calendar-today', body: calendarToday },
  { name: 'commit-helper', body: commitHelper },
  { name: 'cost-recap', body: costRecap },
  { name: 'daily-brief', body: dailyBrief },
  { name: 'daily-recap', body: dailyRecap },
  { name: 'inbox-calibrate', body: inboxCalibrate },
  { name: 'inbox-curate', body: inboxCurate },
  { name: 'linear-inbox', body: linearInbox },
  { name: 'meeting-debrief', body: meetingDebrief },
  { name: 'memory-trim', body: memoryTrim },
  { name: 'pr-address-comments', body: prAddressComments },
  { name: 'pr-review-queue', body: prReviewQueue },
  { name: 'send', body: send },
  { name: 'skill-author', body: skillAuthor },
  { name: 'slack-inbox', body: slackInbox },
  { name: 'status', body: status },
  { name: 'ticket-to-pr', body: ticketToPr },
  { name: 'today-focus', body: todayFocus },
  { name: 'weekly-retro', body: weeklyRetro },
  { name: 'workflow-author', body: workflowAuthor },
];

export {
  SAMPLE_INBOX_PRIORITIES,
  SAMPLE_MCP_CONFIG,
  SAMPLE_PROJECTS,
} from './samples.js';
