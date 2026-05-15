import { useEffect, useMemo, useState } from 'react';

import type {
  InboxItem,
  Reminder,
  RoutineDef,
} from '../../shared/types';
import {
  ScheduledItemDetail,
  formatClockTime,
  startOfDay,
} from '../views/ScheduledItemDetail';
import {
  KIND_LABEL,
  buildScheduledItems,
  type ScheduledItem,
} from '../views/scheduled-items';

type View = 'month' | 'week' | 'day' | 'agenda';

const VIEW_KEY = 'jarvis.calendar.view';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Standalone Calendar module page. The agenda view IS the same
 * timeline the Dashboard renders (via shared buildScheduledItems +
 * ScheduledItemDetail) so click-to-act behaviour is identical across
 * surfaces; Month/Week/Day are Google Calendar-style chronological
 * views over the same data.
 *
 * View choice persists to localStorage. Anchor date defaults to today
 * and resets to today every time the user clicks "Today".
 */
export function CalendarPage() {
  const [view, setView] = useState<View>(() => loadView());
  const [anchor, setAnchor] = useState<number>(() => Date.now());
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [routines, setRoutines] = useState<RoutineDef[]>([]);
  const [selected, setSelected] = useState<ScheduledItem | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void window.jarvis.listInbox().then(setInboxItems);
    void window.jarvis.listReminders().then(setReminders);
    void window.jarvis.listRoutines().then(setRoutines);
    const offInbox = window.jarvis.onInboxChanged(setInboxItems);
    const offRem = window.jarvis.onRemindersChanged(setReminders);
    const offRoute = window.jarvis.onRoutinesChanged(setRoutines);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      offInbox();
      offRem();
      offRoute();
      clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  // Horizon depends on view — Month needs ~60 days so the next page
  // can show routine fires.
  const horizonDays = view === 'month' ? 60 : view === 'week' ? 21 : 14;
  const items = useMemo(
    () => buildScheduledItems(inboxItems, reminders, routines, now, horizonDays),
    [inboxItems, reminders, routines, now, horizonDays],
  );

  return (
    <div className="module-page calendar-page">
      <header className="module-page__header">
        <div>
          <h2>CALENDAR</h2>
          <p>
            Google Calendar + reminders + routine fires · same data the
            Dashboard surfaces, in Google-Calendar-style views.
          </p>
        </div>
        <div className="calendar-page__view-tabs">
          {(['month', 'week', 'day', 'agenda'] as View[]).map((v) => (
            <button
              key={v}
              className={`calendar-page__view-tab${v === view ? ' calendar-page__view-tab--active' : ''}`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </header>

      <div className="calendar-page__nav">
        <button onClick={() => setAnchor(stepAnchor(anchor, view, -1))}>
          ←
        </button>
        <button onClick={() => setAnchor(Date.now())}>Today</button>
        <button onClick={() => setAnchor(stepAnchor(anchor, view, 1))}>
          →
        </button>
        <span className="calendar-page__nav-label">
          {anchorLabel(anchor, view)}
        </span>
      </div>

      {view === 'agenda' && (
        <AgendaView items={items} now={now} onPick={setSelected} />
      )}
      {view === 'month' && (
        <MonthView
          anchor={anchor}
          items={items}
          now={now}
          onPick={setSelected}
          onZoomDay={(day) => {
            setAnchor(day);
            setView('day');
          }}
        />
      )}
      {view === 'week' && (
        <WeekView anchor={anchor} items={items} now={now} onPick={setSelected} />
      )}
      {view === 'day' && (
        <DayView anchor={anchor} items={items} now={now} onPick={setSelected} />
      )}

      {selected && (
        <ScheduledItemDetail item={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ─── views ────────────────────────────────────────────────────────────

function AgendaView({
  items,
  now,
  onPick,
}: {
  items: ScheduledItem[];
  now: number;
  onPick: (item: ScheduledItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="calendar-page__empty">
        Nothing scheduled. Calendar events appear once the
        google-calendar-events routine has run; reminders + routine
        fires show up automatically.
      </div>
    );
  }
  const groups = groupByDay(items, now);
  return (
    <div className="calendar-agenda">
      {groups.map((g) => (
        <section key={g.label} className="calendar-agenda__group">
          <h3>{g.label}</h3>
          <ul>
            {g.items.map((it) => (
              <li key={it.id}>
                <button
                  className={`calendar-row${rowClasses(it, now)}`}
                  onClick={() => onPick(it)}
                >
                  <span className="calendar-row__time">
                    {formatClockTime(it.fireAt)}
                  </span>
                  <KindBadge kind={it.kind} />
                  <span className="calendar-row__title">{it.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MonthView({
  anchor,
  items,
  now,
  onPick,
  onZoomDay,
}: {
  anchor: number;
  items: ScheduledItem[];
  now: number;
  onPick: (item: ScheduledItem) => void;
  onZoomDay: (dayMs: number) => void;
}) {
  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const byDay = useMemo(() => itemsByDay(items), [items]);
  const todayMs = startOfDay(now);
  const anchorMonth = new Date(anchor).getMonth();

  return (
    <div className="calendar-month">
      <div className="calendar-month__header">
        {DAY_NAMES.map((d) => (
          <div key={d} className="calendar-month__dow">
            {d}
          </div>
        ))}
      </div>
      <div className="calendar-month__grid">
        {grid.map((day) => {
          const dayItems = byDay.get(day) ?? [];
          const inMonth = new Date(day).getMonth() === anchorMonth;
          const isToday = day === todayMs;
          return (
            <div
              key={day}
              className={`calendar-month__cell${inMonth ? '' : ' calendar-month__cell--out'}${isToday ? ' calendar-month__cell--today' : ''}`}
            >
              <button
                className="calendar-month__date"
                onClick={() => onZoomDay(day)}
                title="Open this day"
              >
                {new Date(day).getDate()}
              </button>
              <div className="calendar-month__items">
                {dayItems.slice(0, 3).map((it) => (
                  <button
                    key={it.id}
                    className={`calendar-month__item calendar-month__item--${it.kind}`}
                    onClick={() => onPick(it)}
                    title={`${formatClockTime(it.fireAt)} · ${it.title}`}
                  >
                    <span className="calendar-month__item-time">
                      {formatClockTime(it.fireAt)}
                    </span>
                    <span className="calendar-month__item-title">{it.title}</span>
                  </button>
                ))}
                {dayItems.length > 3 && (
                  <button
                    className="calendar-month__more"
                    onClick={() => onZoomDay(day)}
                  >
                    +{dayItems.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  anchor,
  items,
  now,
  onPick,
}: {
  anchor: number;
  items: ScheduledItem[];
  now: number;
  onPick: (item: ScheduledItem) => void;
}) {
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const byDay = useMemo(() => itemsByDay(items), [items]);
  const todayMs = startOfDay(now);
  return (
    <div className="calendar-week">
      {days.map((day) => {
        const dayItems = byDay.get(day) ?? [];
        const isToday = day === todayMs;
        const d = new Date(day);
        return (
          <section
            key={day}
            className={`calendar-week__day${isToday ? ' calendar-week__day--today' : ''}`}
          >
            <header className="calendar-week__day-head">
              <span className="calendar-week__dow">{DAY_NAMES[d.getDay()]}</span>
              <span className="calendar-week__date">{d.getDate()}</span>
            </header>
            <ul className="calendar-week__items">
              {dayItems.length === 0 && (
                <li className="calendar-week__empty">—</li>
              )}
              {dayItems.map((it) => (
                <li key={it.id}>
                  <button
                    className={`calendar-row${rowClasses(it, now)}`}
                    onClick={() => onPick(it)}
                  >
                    <span className="calendar-row__time">
                      {formatClockTime(it.fireAt)}
                    </span>
                    <KindBadge kind={it.kind} small />
                    <span className="calendar-row__title">{it.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function DayView({
  anchor,
  items,
  now,
  onPick,
}: {
  anchor: number;
  items: ScheduledItem[];
  now: number;
  onPick: (item: ScheduledItem) => void;
}) {
  const day = startOfDay(anchor);
  const dayItems = useMemo(
    () =>
      items
        .filter((it) => startOfDay(it.fireAt) === day)
        .sort((a, b) => a.fireAt - b.fireAt),
    [items, day],
  );
  const isToday = day === startOfDay(now);
  const nowOffset = isToday
    ? (((now - day) / (24 * 60 * 60 * 1000)) * 24 * HOUR_HEIGHT)
    : null;

  return (
    <div className="calendar-day">
      <div className="calendar-day__hours">
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} className="calendar-day__hour">
            <span className="calendar-day__hour-label">{pad2(h)}:00</span>
            <div className="calendar-day__hour-line" />
          </div>
        ))}
        {dayItems.map((it) => {
          const start = it.fireAt - day;
          const top = (start / (60 * 60 * 1000)) * HOUR_HEIGHT;
          return (
            <button
              key={it.id}
              className={`calendar-day__item calendar-day__item--${it.kind}${rowClasses(it, now)}`}
              style={{ top: `${top}px` }}
              onClick={() => onPick(it)}
            >
              <span className="calendar-row__time">
                {formatClockTime(it.fireAt)}
              </span>
              <KindBadge kind={it.kind} small />
              <span className="calendar-row__title">{it.title}</span>
            </button>
          );
        })}
        {nowOffset != null && (
          <div
            className="calendar-day__now"
            style={{ top: `${nowOffset}px` }}
            title="Now"
          />
        )}
      </div>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

const HOUR_HEIGHT = 44;

function KindBadge({
  kind,
  small,
}: {
  kind: ScheduledItem['kind'];
  small?: boolean;
}) {
  return (
    <span
      className={`calendar-kind calendar-kind--${kind}${small ? ' calendar-kind--small' : ''}`}
      title={KIND_LABEL[kind]}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

function rowClasses(it: ScheduledItem, now: number): string {
  const diff = it.fireAt - now;
  if (diff < 0) return ' calendar-row--past';
  if (diff < 10 * 60 * 1000) return ' calendar-row--soon';
  return '';
}

function loadView(): View {
  try {
    const v = window.localStorage.getItem(VIEW_KEY) as View | null;
    if (v === 'month' || v === 'week' || v === 'day' || v === 'agenda') return v;
  } catch {
    /* ignore */
  }
  return 'agenda';
}

function stepAnchor(ms: number, view: View, dir: -1 | 1): number {
  const d = new Date(ms);
  if (view === 'month') d.setMonth(d.getMonth() + dir);
  else if (view === 'week') d.setDate(d.getDate() + 7 * dir);
  else if (view === 'day') d.setDate(d.getDate() + dir);
  else d.setDate(d.getDate() + 7 * dir);
  return d.getTime();
}

function anchorLabel(ms: number, view: View): string {
  const d = new Date(ms);
  if (view === 'month') {
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  if (view === 'week') {
    const start = new Date(weekDays(ms)[0]!);
    const end = new Date(weekDays(ms)[6]!);
    const sameMonth = start.getMonth() === end.getMonth();
    return sameMonth
      ? `${start.toLocaleDateString(undefined, { month: 'short' })} ${start.getDate()}–${end.getDate()}`
      : `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
  if (view === 'day') {
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  }
  return 'Agenda';
}

function monthGrid(anchor: number): number[] {
  // 6 × 7 = 42 cells. Start Sunday on or before the 1st of the
  // anchor's month; walk 42 days forward.
  const d = new Date(anchor);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  d.setDate(1 - d.getDay()); // back to nearest Sunday
  const out: number[] = [];
  for (let i = 0; i < 42; i++) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function weekDays(anchor: number): number[] {
  const d = new Date(anchor);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function itemsByDay(items: ScheduledItem[]): Map<number, ScheduledItem[]> {
  const map = new Map<number, ScheduledItem[]>();
  for (const it of items) {
    const day = startOfDay(it.fireAt);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(it);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.fireAt - b.fireAt);
  return map;
}

function groupByDay(
  items: ScheduledItem[],
  now: number,
): Array<{ label: string; items: ScheduledItem[] }> {
  const today = startOfDay(now);
  const tomorrow = today + 24 * 60 * 60 * 1000;
  const weekEnd = today + 7 * 24 * 60 * 60 * 1000;
  const groups: Record<string, ScheduledItem[]> = {};
  for (const it of items) {
    let key: string;
    if (it.fireAt < today) key = 'Past';
    else if (it.fireAt < tomorrow) key = 'Today';
    else if (it.fireAt < tomorrow + 24 * 60 * 60 * 1000) key = 'Tomorrow';
    else if (it.fireAt < weekEnd) key = 'This week';
    else key = 'Later';
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(it);
  }
  const order = ['Past', 'Today', 'Tomorrow', 'This week', 'Later'];
  return order
    .filter((k) => groups[k])
    .map((k) => ({ label: k, items: groups[k]! }));
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
