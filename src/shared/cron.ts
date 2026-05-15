/**
 * Minimal next-fire computation for standard 5-field cron expressions
 * (`m h dom mon dow`). Used to surface "when does this routine fire
 * next?" without dragging in node-cron (Node-only) or cron-parser (a
 * ~25KB dep) — both overkill for the handful of patterns Jarvis
 * routines actually use.
 *
 * Supports per-field: `*`, integer, range (`a-b`), comma list
 * (`a,b,c`), step (`* / N` or `a-b/N`). Day-of-week: 0 = Sunday.
 * Returns null on parse failure (caller should hide the chip rather
 * than render "Invalid Date").
 */

export function nextCronFire(
  expr: string,
  after: number = Date.now(),
): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  let minutes: number[], hours: number[], doms: number[], mons: number[], dows: number[];
  try {
    minutes = parseField(parts[0]!, 0, 59);
    hours = parseField(parts[1]!, 0, 23);
    doms = parseField(parts[2]!, 1, 31);
    mons = parseField(parts[3]!, 1, 12);
    dows = parseField(parts[4]!, 0, 6);
  } catch {
    return null;
  }
  const mSet = new Set(minutes);
  const hSet = new Set(hours);
  const domSet = new Set(doms);
  const monSet = new Set(mons);
  const dowSet = new Set(dows);

  // Start one minute after `after`, walk forward minute-by-minute. Cap
  // at 366 days so we always terminate.
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() < limit) {
    const min = d.getMinutes();
    const hour = d.getHours();
    const dom = d.getDate();
    const mon = d.getMonth() + 1;
    const dow = d.getDay();
    // POSIX-style: when both dom and dow are restricted (neither is `*`)
    // a match in EITHER triggers. When one is `*` only the other applies.
    const domStarred = parts[2] === '*';
    const dowStarred = parts[4] === '*';
    const domMatch = domSet.has(dom);
    const dowMatch = dowSet.has(dow);
    const dayMatch =
      domStarred && dowStarred
        ? true
        : domStarred
          ? dowMatch
          : dowStarred
            ? domMatch
            : domMatch || dowMatch;
    if (
      mSet.has(min) &&
      hSet.has(hour) &&
      monSet.has(mon) &&
      dayMatch
    ) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function parseField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    let stepStr: string | undefined;
    let rest = part;
    if (part.includes('/')) {
      const [r, s] = part.split('/');
      rest = r!;
      stepStr = s;
    }
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error('bad step');
    if (rest === '*') {
      for (let v = min; v <= max; v += step) out.add(v);
    } else if (rest.includes('-')) {
      const [a, b] = rest.split('-').map((s) => parseInt(s, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('bad range');
      for (let v = a!; v <= b!; v += step) out.add(v);
    } else {
      const v = parseInt(rest, 10);
      if (!Number.isFinite(v)) throw new Error('bad number');
      out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}
