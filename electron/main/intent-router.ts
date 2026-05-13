/**
 * Pure-function intent parser for the palette's free-text prompts.
 *
 * Today: pattern-based — looks for "remind me ... in N min/h", "remind me at
 * HH:MM", "remind me tomorrow at HH:MM". Falls through to a regular task.
 *
 * Future: graduate to a fast Claude pass with structured output if patterns
 * get unwieldy. The signature here is stable so the upgrade is a drop-in.
 */

import type { ReminderMode } from '@shared/types';

export type ParsedIntent =
  | { kind: 'task'; body: string }
  | { kind: 'reminder'; mode: ReminderMode; body: string; fireAt: number };

const REMINDER_PREFIX = /^\s*(?:please\s+)?remind\s+me\s*(?:to\s+|that\s+|about\s+)?/i;

interface TimePhrase {
  /** ms offset from now (or absolute via fireAt) */
  delayMs?: number;
  fireAt?: number;
  /** Source range in the input so we can strip it from the body. */
  start: number;
  end: number;
}

function parseRelativeIn(input: string): TimePhrase | null {
  // "in 2 hours", "in 30 min", "in 1h", "in 45m", "in an hour", "in a minute"
  const re =
    /\bin\s+(an?|\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i;
  const m = re.exec(input);
  if (!m) return null;
  const rawN = m[1]!;
  const unit = m[2]!.toLowerCase();
  const n = /^an?$/i.test(rawN) ? 1 : parseFloat(rawN);
  if (!Number.isFinite(n)) return null;
  let unitMs = 0;
  if (/^(s|sec|secs|second|seconds)$/.test(unit)) unitMs = 1_000;
  else if (/^(m|min|mins|minute|minutes)$/.test(unit)) unitMs = 60_000;
  else if (/^(h|hr|hrs|hour|hours)$/.test(unit)) unitMs = 3_600_000;
  else if (/^(d|day|days)$/.test(unit)) unitMs = 86_400_000;
  else return null;
  return { delayMs: Math.round(n * unitMs), start: m.index, end: m.index + m[0].length };
}

function parseAtClock(input: string, now: Date): TimePhrase | null {
  // "at 17:30", "at 5pm", "at 5:30pm"
  const re = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const m = re.exec(input);
  if (!m) return null;
  let hours = parseInt(m[1]!, 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hours < 12) hours += 12;
  else if (ampm === 'am' && hours === 12) hours = 0;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  // If the time has already passed today, assume tomorrow.
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return { fireAt: target.getTime(), start: m.index, end: m.index + m[0].length };
}

function parseTomorrowAt(input: string, now: Date): TimePhrase | null {
  // "tomorrow at 9", "tomorrow morning" (treat morning=09:00, evening=18:00)
  const reExact = /\btomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const m = reExact.exec(input);
  if (m) {
    let hours = parseInt(m[1]!, 10);
    const minutes = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    else if (ampm === 'am' && hours === 12) hours = 0;
    if (hours < 0 || hours > 23) return null;
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(hours, minutes, 0, 0);
    return { fireAt: target.getTime(), start: m.index, end: m.index + m[0].length };
  }
  const reLoose = /\btomorrow(?:\s+(morning|afternoon|evening|night))?\b/i;
  const m2 = reLoose.exec(input);
  if (m2) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    const part = m2[1]?.toLowerCase();
    const hours = part === 'afternoon' ? 14 : part === 'evening' || part === 'night' ? 18 : 9;
    target.setHours(hours, 0, 0, 0);
    return { fireAt: target.getTime(), start: m2.index, end: m2.index + m2[0].length };
  }
  return null;
}

/**
 * Strip the matched time phrase, the "remind me ..." prefix, and clean up
 * leftover connectives. Returns the body the reminder should remind about.
 */
function extractBody(input: string, phrase: TimePhrase): string {
  let body = input.slice(0, phrase.start) + input.slice(phrase.end);
  body = body.replace(REMINDER_PREFIX, '');
  body = body
    // Strip leading/trailing connectives that "in 20 min, " leaves behind.
    .replace(/^[\s,;:.]+/, '')
    .replace(/[\s,;:.]+$/, '')
    .replace(/^\s*(and|then|to|that|about)\s+/i, '')
    .replace(/\s+(and|then|to|that|about)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return body;
}

export function parseIntent(input: string, now: Date = new Date()): ParsedIntent {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'task', body: trimmed };
  const isReminder = REMINDER_PREFIX.test(trimmed);

  const phrase =
    parseTomorrowAt(trimmed, now) ?? parseAtClock(trimmed, now) ?? parseRelativeIn(trimmed);
  if (!phrase) return { kind: 'task', body: trimmed };

  // Time phrase + any imperative-ish body → schedule it. False positives
  // ("the bug that landed in 5 min builds") are recoverable: the user sees
  // the "Scheduled · 14:05" confirmation notification immediately and can
  // cancel by clicking the amber node on the constellation. False
  // *negatives* would silently drop the action, which is worse.
  const fireAt = phrase.fireAt ?? now.getTime() + (phrase.delayMs ?? 0);
  const body = extractBody(trimmed, phrase);
  if (!body) return { kind: 'task', body: trimmed };
  return {
    kind: 'reminder',
    mode: isReminder ? 'reminder' : 'scheduled',
    body,
    fireAt,
  };
}
