// Tiny standard-cron field matcher.
//
// Used by the boot-time catch-up pass in `WorkflowScheduler`: given a
// cron expression and the [lastRunAt, now] window, tell whether the
// cron WOULD have fired at any point during the gap. If yes, the
// workflow is overdue and we fire it once on boot.
//
// No `node-cron` API for this; `cron-parser` would solve it cleanly
// but adds ~50KB + transitive deps. The patterns Jarvis seeds
// (every-N-minute crons, daily-at-N, hourly-step) are simple enough
// that a 60-line matcher covers every case.
//
// Supported field syntax:
//   - `*`            — match any
//   - `N`            — match exact value
//   - `N-M`          — closed range
//   - `STEP/N`       — every N (modulo from field minimum); STEP is `*` or a range
//   - `A,B,C`        — comma list of any of the above
//
// NOT supported (Jarvis doesn't use them):
//   - `L`, `W`, `?` extensions
//   - Named weekdays (`MON`, `TUE`, …)
//   - Seconds field (5-field crons only)

function matchField(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  if (field === '*') return true;
  if (field.includes(',')) {
    return field.split(',').some((p) => matchField(p, value, min, max));
  }
  const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(field);
  if (stepMatch) {
    const base = stepMatch[1]!;
    const step = parseInt(stepMatch[2]!, 10);
    if (step <= 0) return false;
    if (base === '*') {
      return (value - min) % step === 0;
    }
    const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(base);
    if (!rangeMatch) return false;
    const lo = parseInt(rangeMatch[1]!, 10);
    const hi = rangeMatch[2] != null ? parseInt(rangeMatch[2], 10) : max;
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  }
  const rangeMatch = /^(\d+)-(\d+)$/.exec(field);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]!, 10);
    const hi = parseInt(rangeMatch[2]!, 10);
    return value >= lo && value <= hi;
  }
  if (/^\d+$/.test(field)) {
    return parseInt(field, 10) === value;
  }
  return false;
}

/** True iff `cronExpr` would fire at `date` (local time). 5-field. */
export function cronMatchesAt(cronExpr: string, date: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length < 5) return false;
  const [m, h, dom, mon, dow] = fields;
  if (!matchField(m!, date.getMinutes(), 0, 59)) return false;
  if (!matchField(h!, date.getHours(), 0, 23)) return false;
  if (!matchField(dom!, date.getDate(), 1, 31)) return false;
  if (!matchField(mon!, date.getMonth() + 1, 1, 12)) return false;
  if (!matchField(dow!, date.getDay(), 0, 6)) return false;
  return true;
}

/**
 * Whether `cronExpr` was supposed to fire at any point in
 * (lastRunAt, now]. Used to decide if a workflow is "overdue" after
 * the app was offline.
 *
 *   - lastRunAt == null            → never ran; treat any historical
 *                                    match in the last `maxLookbackMs`
 *                                    window as overdue
 *   - lastRunAt very recent        → no missed fires (cheap exit)
 *   - lastRunAt > maxLookbackMs    → cap the scan window so we don't
 *                                    iterate years of minutes
 *
 * Iterates one minute at a time — for a week-long window that's
 * ~10k iterations, microseconds total.
 */
export function isOverdue(
  cronExpr: string,
  lastRunAt: number | null,
  now: number = Date.now(),
  maxLookbackMs: number = 7 * 24 * 60 * 60_000,
): boolean {
  const windowStart = Math.max(
    (lastRunAt ?? 0) + 60_000,
    now - maxLookbackMs,
  );
  if (windowStart > now) return false;
  // Walk in minute steps. Trim seconds to keep alignment crisp.
  let t = Math.floor(windowStart / 60_000) * 60_000;
  const end = Math.floor(now / 60_000) * 60_000;
  while (t <= end) {
    if (cronMatchesAt(cronExpr, new Date(t))) return true;
    t += 60_000;
  }
  return false;
}
