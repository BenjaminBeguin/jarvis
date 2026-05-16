import type { InboxItem } from './types';

/**
 * Urgency scoring for inbox items — single source of truth shared
 * between main (`InboxStore` sorts with it) and renderer (Now view
 * + future "show top N urgent" surfaces can re-rank consistently).
 *
 * Three contributions, summed:
 *   - **Time pressure** (dominant): fireAt distance bands
 *     `<30 min` → +1000, `<4 h` → +200, `<24 h` → +50, else +10.
 *     Past-due within 24 h → +500 (fired-but-not-handled stays
 *     urgent).
 *   - **Source weight**: reminders (100) > failed-routines (80)
 *     > pr-comments (60) > linear/slack (50) > pr-review (40)
 *     > calendar/meeting-activity (30) > unknown (20) > dedupe (10).
 *   - **Age bump** (+20) when `createdAt` is older than 24h, so a
 *     quiet PR review doesn't sit below tomorrow's calendar fluff
 *     forever.
 *
 * Sort consumers should use `byUrgency` for a stable comparator
 * (score desc, then soonest fireAt, then newest createdAt).
 */

export const SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  reminders: 100,
  'failed-routines': 80,
  'pr-comments': 60,
  linear: 50,
  slack: 50,
  'pr-review': 40,
  calendar: 30,
  'meeting-activity': 30,
  dedupe: 10,
};

export function urgencyScore(item: InboxItem, now: number = Date.now()): number {
  let s = 0;
  if (item.fireAt != null) {
    const dt = item.fireAt - now;
    if (dt > 0) {
      if (dt < 30 * 60_000) s += 1000;
      else if (dt < 4 * 60 * 60_000) s += 200;
      else if (dt < 24 * 60 * 60_000) s += 50;
      else s += 10;
    } else if (dt > -24 * 60 * 60_000) {
      s += 500;
    }
  }
  s += SOURCE_WEIGHTS[item.source] ?? 20;
  if (item.createdAt && now - item.createdAt > 24 * 60 * 60_000) {
    s += 20;
  }
  return s;
}

/** Higher score first; ties → soonest fireAt; remaining ties → newest createdAt. */
export function byUrgency(a: InboxItem, b: InboxItem, now: number = Date.now()): number {
  const sa = urgencyScore(a, now);
  const sb = urgencyScore(b, now);
  if (sa !== sb) return sb - sa;
  if (a.fireAt != null && b.fireAt != null) return a.fireAt - b.fireAt;
  if (a.fireAt != null) return -1;
  if (b.fireAt != null) return 1;
  return b.createdAt - a.createdAt;
}
