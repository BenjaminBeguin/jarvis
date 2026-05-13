import { useEffect, useState } from 'react';

/**
 * Subscribe to a periodic 'now' tick so countdown labels ("in 20m", "3
 * min ago") stay fresh without each consumer rolling their own
 * setInterval. Default 30s — fine for minute-grained labels; pass a
 * smaller intervalMs if you need sub-minute precision.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
