import type { WorkflowDef } from '@shared/types';

import { LINEAR_INBOX_WORKFLOW } from './linear-inbox.js';

/**
 * Built-in workflow catalogue. Each entry is seeded on first launch
 * if missing — user edits to `~/.jarvis/workflows/<id>.json` are
 * never overwritten. Adding a workflow: drop a file under
 * `./seeds/workflows/<name>.ts` exporting a `WorkflowDef`, then add
 * it to the list below.
 */
export const BUILTIN_WORKFLOWS: WorkflowDef[] = [LINEAR_INBOX_WORKFLOW];
