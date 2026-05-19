import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-scenario feedback memory. Each autopilot workflow has its own
 * markdown file at `~/.jarvis/autopilot/feedback/<workflowId>.md`,
 * an append-only log of accept/reject decisions plus user notes.
 *
 * The `run-skill` workflow node substitutes `{feedback}` in its
 * prompt template with this file's contents, so the agent's next
 * draft sees what the user liked / corrected last time. Compound
 * improvement over time, no embeddings — plain markdown the user
 * can also hand-edit.
 *
 * Capped at MAX_BYTES; trims oldest entries when over.
 */

export interface FeedbackEntry {
  decision: 'ACCEPTED' | 'REJECTED';
  context?: string;
  drafted?: string;
  feedback?: string;
}

const ROOT = join(homedir(), '.jarvis', 'autopilot', 'feedback');
const MAX_BYTES = 64 * 1024;

function pathFor(workflowId: string): string {
  // Defensive id sanitization — workflowId is user-supplied and we
  // refuse anything that could break out of the dir.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(workflowId)) {
    throw new Error(`feedback-store: invalid workflowId "${workflowId}"`);
  }
  return join(ROOT, `${workflowId}.md`);
}

/** Read the current feedback log for a workflow. Empty string if no file. */
export function readFeedback(workflowId: string): string {
  const file = pathFor(workflowId);
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    console.warn(`feedback-store: failed to read ${file}:`, err);
    return '';
  }
}

/**
 * Append a new entry. Creates the file on first call. Trims oldest
 * entries when the file exceeds MAX_BYTES.
 *
 * Entry format:
 *
 *   ## 2026-05-18T22:00:00Z — REJECTED
 *   **Context**: …
 *   **Drafted**: …
 *   **Feedback**: …
 */
export function appendFeedback(
  workflowId: string,
  entry: FeedbackEntry,
): void {
  const file = pathFor(workflowId);
  mkdirSync(ROOT, { recursive: true });
  const ts = new Date().toISOString();
  const lines: string[] = [
    '',
    `## ${ts} — ${entry.decision}`,
  ];
  if (entry.context && entry.context.trim()) {
    lines.push(`**Context**: ${entry.context.trim()}`);
  }
  if (entry.drafted && entry.drafted.trim()) {
    lines.push(`**Drafted**: ${truncate(entry.drafted.trim(), 800)}`);
  }
  if (entry.feedback && entry.feedback.trim()) {
    lines.push(`**Feedback**: ${entry.feedback.trim()}`);
  }
  const block = lines.join('\n') + '\n';
  if (!existsSync(file)) {
    writeFileSync(
      file,
      `# Feedback for ${workflowId}\n` + block,
      'utf8',
    );
  } else {
    appendFileSync(file, block, 'utf8');
  }
  trimIfOversized(file);
}

/**
 * Wipe the log entirely. Used by the Settings panel's "Clear history"
 * button — keeps the file but resets the body so the agent's next
 * run gets a clean slate.
 */
export function clearFeedback(workflowId: string): void {
  const file = pathFor(workflowId);
  if (!existsSync(file)) return;
  writeFileSync(file, `# Feedback for ${workflowId}\n`, 'utf8');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * If the file exceeds MAX_BYTES, drop the oldest `## ` blocks until
 * it fits. Cheapest reasonable trim — counts blocks from the top
 * (which are oldest) and removes them. Preserves the file header.
 */
function trimIfOversized(file: string): void {
  try {
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') <= MAX_BYTES) return;
    const lines = raw.split('\n');
    // Find every ## heading line index.
    const headings: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('## ')) headings.push(i);
    }
    // Drop oldest entries until we fit. Keep at least the last 5.
    let dropUpTo = 0;
    while (
      Buffer.byteLength(
        [lines[0], ...lines.slice(headings[dropUpTo + 1] ?? lines.length)].join('\n'),
        'utf8',
      ) > MAX_BYTES &&
      dropUpTo + 5 < headings.length
    ) {
      dropUpTo++;
    }
    if (dropUpTo === 0) return;
    const nextStart = headings[dropUpTo] ?? lines.length;
    const trimmed = [lines[0], ...lines.slice(nextStart)].join('\n');
    writeFileSync(file, trimmed, 'utf8');
  } catch (err) {
    console.warn(`feedback-store: trim failed for ${file}:`, err);
  }
}

/**
 * Latest N entries in structured form. Used by the Settings →
 * Autopilot panel to show a feedback trail per workflow. Parses the
 * append-only markdown back into entries — round-trips with
 * appendFeedback above.
 */
export interface ParsedEntry extends FeedbackEntry {
  ts: number;
}

export function listFeedback(workflowId: string, limit = 10): ParsedEntry[] {
  const raw = readFeedback(workflowId);
  if (!raw) return [];
  const blocks = raw.split(/\n## /).slice(1); // drop the file header.
  const parsed: ParsedEntry[] = [];
  for (const block of blocks) {
    const [head, ...body] = block.split('\n');
    if (!head) continue;
    const m = /^(\S+)\s—\s(ACCEPTED|REJECTED)/.exec(head);
    if (!m) continue;
    const ts = Date.parse(m[1]!);
    const decision = m[2] as 'ACCEPTED' | 'REJECTED';
    const entry: ParsedEntry = { ts: Number.isFinite(ts) ? ts : 0, decision };
    for (const line of body) {
      const ctxM = /^\*\*Context\*\*:\s(.*)$/.exec(line);
      if (ctxM) entry.context = ctxM[1];
      const dM = /^\*\*Drafted\*\*:\s(.*)$/.exec(line);
      if (dM) entry.drafted = dM[1];
      const fM = /^\*\*Feedback\*\*:\s(.*)$/.exec(line);
      if (fM) entry.feedback = fM[1];
    }
    parsed.push(entry);
  }
  return parsed.slice(-limit).reverse();
}
