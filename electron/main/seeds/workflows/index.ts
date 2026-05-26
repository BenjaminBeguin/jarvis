import type { WorkflowDef } from '@shared/types';

import { AUTOPILOT_GMAIL_TRIAGE_WORKFLOW } from './autopilot-gmail-triage.js';
import { AUTOPILOT_PR_COMMENTS_WORKFLOW } from './autopilot-pr-comments.js';
import { AUTOPILOT_PR_REVIEW_NON_TEAM_WORKFLOW } from './autopilot-pr-review-non-team.js';
import { AUTOPILOT_SLACK_DM_ACK_WORKFLOW } from './autopilot-slack-dm-ack.js';
import { CALENDAR_TODAY_WORKFLOW } from './calendar-today.js';
import { DAILY_LEARN_WORKFLOW } from './daily-learn.js';
import { GOAL_PROGRESS_WORKFLOW } from './goal-progress.js';
import { INBOX_CURATE_WORKFLOW } from './inbox-curate.js';
import { JARVIS_SELF_GRADE_WORKFLOW } from './jarvis-self-grade.js';
import { MORNING_BRIEF_WORKFLOW } from './morning-brief.js';
import { LINEAR_INBOX_WORKFLOW } from './linear-inbox.js';
import { SLACK_INBOX_WORKFLOW } from './slack-inbox.js';
import { TECH_WATCH_WORKFLOW } from './tech-watch.js';
import { WORK_AWARENESS_WORKFLOW } from './work-awareness.js';

/**
 * Built-in workflow catalogue. Each entry is seeded on first launch
 * if missing — user edits to `~/.jarvis/workflows/<id>.json` are
 * never overwritten. Adding a workflow: drop a file under
 * `./seeds/workflows/<name>.ts` exporting a `WorkflowDef`, then add
 * it to the list below.
 */
export const BUILTIN_WORKFLOWS: WorkflowDef[] = [
  LINEAR_INBOX_WORKFLOW,
  SLACK_INBOX_WORKFLOW,
  CALENDAR_TODAY_WORKFLOW,
  TECH_WATCH_WORKFLOW,
  INBOX_CURATE_WORKFLOW,
  WORK_AWARENESS_WORKFLOW,
  DAILY_LEARN_WORKFLOW,
  GOAL_PROGRESS_WORKFLOW,
  JARVIS_SELF_GRADE_WORKFLOW,
  MORNING_BRIEF_WORKFLOW,
  // Autopilot scenarios — all default `enabled: false`. Users opt in
  // per-scenario from Settings → Workflows (or directly in the JSON).
  AUTOPILOT_PR_REVIEW_NON_TEAM_WORKFLOW,
  AUTOPILOT_PR_COMMENTS_WORKFLOW,
  AUTOPILOT_SLACK_DM_ACK_WORKFLOW,
  AUTOPILOT_GMAIL_TRIAGE_WORKFLOW,
];
