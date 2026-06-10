import { useEffect, useMemo, useRef, useState } from 'react';

import type { InboxItem, ProjectDef } from '../../../shared/types';
import { inWorkspace } from '../workspaces/inWorkspace';
import { useWorkspace } from '../workspaces/useWorkspace';

/**
 * TodayTimeline — thin horizontal time-anchor for the Bridge.
 *
 * Shows the current workday as a left-to-right ribbon with:
 *   - working-hours bracket (faint, from config.workingHours)
 *   - now-marker vertical line (animated subtle pulse)
 *   - calendar-source inbox items rendered as small blips at
 *     their fireAt position
 *   - hover a blip → tooltip with title + time
 *   - click a blip → opens meeting URL (when set)
 *
 * Iron-Man HUD detail: ticks at the hour marks, alignment chevrons
 * at the start/end of the visible window, current-hour highlight
 * brackets.
 *
 * Visual budget: 56px tall. Sits between Focus and Pulse so the
 * eye scans Focus → Today → Pulse without losing context.
 */

const DAY_START_HOUR = 0; // ribbon covers the full 24h day…
const DAY_END_HOUR = 24;
const HOUR_WIDTH_PX = 100; // …at a generous 100px per hour, so the user
//                             can scroll and read individual blocks.
//                             24 × 100 = 2400px content width.
const TOTAL_HOURS = DAY_END_HOUR - DAY_START_HOUR;

interface WorkingHours {
  startHour: number;
  endHour: number;
}

export function TodayTimeline() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [projects, setProjects] = useState<ProjectDef[]>([]);
  const [now, setNow] = useState(Date.now());
  const [workingHours, setWorkingHours] = useState<WorkingHours>({
    startHour: 9,
    endHour: 18,
  });
  const workspace = useWorkspace();

  useEffect(() => {
    void window.jarvis.listInbox().then(setItems);
    return window.jarvis.onInboxChanged(setItems);
  }, []);

  // Projects power the workspace filter — a calendar item tagged with
  // a project that lives in another workspace gets dropped from the
  // timeline so the bridge stays scoped. Items without a project
  // match (no `project` field + no name hit) are kept (global).
  useEffect(() => {
    void window.jarvis.listProjects().then(setProjects);
    return window.jarvis.onProjectsChanged(setProjects);
  }, []);

  useEffect(() => {
    void window.jarvis.workingHoursRead().then((wh) => {
      if (wh && typeof wh.startHour === 'number' && typeof wh.endHour === 'number') {
        setWorkingHours({ startHour: wh.startHour, endHour: wh.endHour });
      }
    });
  }, []);

  // 30s tick to keep the now-marker moving + reveal late meetings as
  // they enter the visible window.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const todayMeetings = useMemo(() => {
    const inActive = inWorkspace(workspace.id, projects);
    return filterTodayMeetings(items.filter(inActive), now);
  }, [items, now, workspace.id, projects]);

  const startOfDay = useMemo(() => {
    const d = new Date(now);
    d.setHours(DAY_START_HOUR, 0, 0, 0);
    return d.getTime();
  }, [now]);
  const endOfDay = useMemo(() => {
    const d = new Date(now);
    d.setHours(DAY_END_HOUR, 0, 0, 0);
    return d.getTime();
  }, [now]);

  // Pixel position within the fixed-width content rail (vs the
  // percentage-based approach the earlier flex layout used). Each
  // hour is HOUR_WIDTH_PX pixels wide; offsets are linear from
  // start-of-day.
  const positionPx = (ts: number): number => {
    const span = endOfDay - startOfDay;
    const offset = ts - startOfDay;
    const pct = Math.max(0, Math.min(1, offset / span));
    return pct * (TOTAL_HOURS * HOUR_WIDTH_PX);
  };

  const hourTicks: Array<{ hour: number; px: number }> = [];
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    hourTicks.push({ hour: h, px: positionPx(d.getTime()) });
  }

  const nowPx = positionPx(now);
  const inDayWindow = now >= startOfDay && now <= endOfDay;

  // Working-hours bracket (faint accent so off-hours look "outside" the box).
  const whStart = new Date(now);
  whStart.setHours(workingHours.startHour, 0, 0, 0);
  const whEnd = new Date(now);
  whEnd.setHours(workingHours.endHour, 0, 0, 0);
  const whStartPx = positionPx(whStart.getTime());
  const whEndPx = positionPx(whEnd.getTime());

  // Center the now-marker inside the visible scroll viewport on
  // mount + whenever the marker drifts outside the visible band.
  // Re-checks every minute (via the `now` state tick) so a meeting
  // currently in progress slides into view if you've scrolled away.
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Skip auto-scroll if the user has interacted — they're navigating
    // intentionally and don't want the viewport snapped back.
    if (userScrolledRef.current) return;
    const viewportWidth = el.clientWidth;
    const target = nowPx - viewportWidth / 2;
    el.scrollLeft = Math.max(0, target);
  }, [nowPx]);

  // Mark user-initiated scroll so we stop hijacking the viewport
  // after the first interaction. Wheel + touch + manual scroll all
  // count. The flag resets when the timeline unmounts.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onUserScroll = (): void => {
      userScrolledRef.current = true;
    };
    el.addEventListener('wheel', onUserScroll, { passive: true });
    el.addEventListener('touchstart', onUserScroll, { passive: true });
    el.addEventListener('pointerdown', onUserScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onUserScroll);
      el.removeEventListener('touchstart', onUserScroll);
      el.removeEventListener('pointerdown', onUserScroll);
    };
  }, []);

  const recenter = (): void => {
    userScrolledRef.current = false;
    const el = scrollRef.current;
    if (!el) return;
    const viewportWidth = el.clientWidth;
    el.scrollTo({
      left: Math.max(0, nowPx - viewportWidth / 2),
      behavior: 'smooth',
    });
  };

  const contentWidthPx = TOTAL_HOURS * HOUR_WIDTH_PX;

  return (
    <div className="bridge-today">
      <span className="bridge-today__label">TODAY</span>
      <div className="bridge-today__scroll" ref={scrollRef}>
        <div
          className="bridge-today__rail"
          style={{ width: `${contentWidthPx}px` }}
        >
          {/* Working-hours bracket */}
          <div
            className="bridge-today__work-window"
            style={{
              left: `${whStartPx}px`,
              width: `${Math.max(0, whEndPx - whStartPx)}px`,
            }}
            aria-hidden
          />
          {/* Hour ticks */}
          {hourTicks.map(({ hour, px }) => (
            <div
              key={hour}
              className={`bridge-today__tick${
                hour % 3 === 0 ? ' bridge-today__tick--major' : ''
              }`}
              style={{ left: `${px}px` }}
              aria-hidden
            >
              <span
                className={`bridge-today__tick-label${
                  hour % 3 === 0 ? '' : ' bridge-today__tick-label--minor'
                }`}
              >
                {hour.toString().padStart(2, '0')}
              </span>
            </div>
          ))}
          {/* Meeting blips */}
          {todayMeetings.map((m) => {
            const px = positionPx(m.item.fireAt!);
            const past = m.item.fireAt! < now;
            return (
              <button
                key={m.item.id}
                type="button"
                className={`bridge-today__blip${
                  past ? ' bridge-today__blip--past' : ''
                }${m.imminent ? ' bridge-today__blip--imminent' : ''}`}
                style={{ left: `${px}px` }}
                title={`${formatTime(m.item.fireAt!)} · ${m.item.title}`}
                onClick={() => {
                  if (m.item.url) void window.jarvis.openExternal(m.item.url);
                }}
              >
                <span className="bridge-today__blip-dot" />
                <span className="bridge-today__blip-title">
                  {m.item.title}
                </span>
              </button>
            );
          })}
          {/* Now marker — visible whenever we're in the 24h day window */}
          {inDayWindow && (
            <div
              className="bridge-today__now"
              style={{ left: `${nowPx}px` }}
              aria-label="now"
            >
              <span className="bridge-today__now-line" />
              <span className="bridge-today__now-time">{formatTime(now)}</span>
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        className="bridge-today__recenter"
        onClick={recenter}
        title="Snap to current time"
        aria-label="Recenter on now"
      >
        ◎
      </button>
    </div>
  );
}

interface TodayMeeting {
  item: InboxItem;
  imminent: boolean;
}

function filterTodayMeetings(items: InboxItem[], now: number): TodayMeeting[] {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  return items
    .filter((i) => i.source === 'calendar' && i.fireAt != null)
    .filter(
      (i) =>
        i.fireAt! >= startOfDay.getTime() && i.fireAt! <= endOfDay.getTime(),
    )
    .map((item) => ({
      item,
      imminent:
        item.fireAt! > now - 60_000 && item.fireAt! < now + 15 * 60_000,
    }));
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
