import { useEffect, useState } from 'react';

import type { Reminder } from '../../shared/types';
import { QuickNotePage } from './QuickNotePage';
import { RemindersPage } from './RemindersPage';

/**
 * Capture surface — Notes and Reminders side-by-side. Both are
 * "things I jot for myself," but the cognitive flow is different
 * (free-form journal vs. time-pressured to-do), so seeing both at
 * once helps you decide which one a thought belongs to without
 * tab-flipping.
 *
 * Layout:
 *   - On wide screens (≥ 1100px): two columns, Notes left,
 *     Reminders right.
 *   - On narrower windows: stacks vertically so neither gets
 *     crushed to unreadable.
 *
 * History note: this used to be a tabbed view (Notes | Reminders
 * pill row). The tabs forced an artificial choice between the two
 * surfaces and added one click for the common "did I write that as
 * a note or a reminder?" check. Side-by-side is the right default.
 *
 * The `initial` prop + 'jarvis:capture-tab' event still exist —
 * they used to set the active tab. Now they highlight the column
 * the caller wanted to draw attention to (subtle border accent for
 * a few seconds) but don't hide the other column.
 */

type CaptureTab = 'notes' | 'reminders';

interface Props {
  initial?: CaptureTab;
}

const HIGHLIGHT_DURATION_MS = 2400;

export function CapturePage({ initial = 'notes' }: Props = {}) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [highlight, setHighlight] = useState<CaptureTab | null>(initial);

  useEffect(() => {
    void window.jarvis.listReminders().then(setReminders);
    return window.jarvis.onRemindersChanged(setReminders);
  }, []);

  useEffect(() => {
    const onFocusTab = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: CaptureTab };
      if (detail?.tab === 'notes' || detail?.tab === 'reminders') {
        setHighlight(detail.tab);
      }
    };
    window.addEventListener('jarvis:capture-tab', onFocusTab);
    return () => window.removeEventListener('jarvis:capture-tab', onFocusTab);
  }, []);

  // Drop the highlight after a couple seconds — it's an attention
  // nudge, not a sticky selection.
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(t);
  }, [highlight]);

  const pendingCount = reminders.filter(
    (r) => r.status === 'pending' || r.status === 'fired',
  ).length;

  return (
    <div className="capture-page">
      <header className="capture-page__header">
        <h2>NOTES &amp; REMINDERS</h2>
        <p className="capture-page__hint">
          Free-form notes <em>and</em> time-pressured reminders, same page.
          Use <code>/note &lt;text&gt;</code> to journal, "remind me in …" /
          "in 2h, …" to schedule.
        </p>
      </header>
      <div className="capture-page__split">
        <section
          className={`capture-page__col capture-page__col--notes${
            highlight === 'notes' ? ' capture-page__col--highlight' : ''
          }`}
          aria-label="Notes"
        >
          <header className="capture-page__col-head">
            <h3>Notes</h3>
          </header>
          <div className="capture-page__col-body">
            <QuickNotePage compact />
          </div>
        </section>
        <section
          className={`capture-page__col capture-page__col--reminders${
            highlight === 'reminders' ? ' capture-page__col--highlight' : ''
          }`}
          aria-label="Reminders"
        >
          <header className="capture-page__col-head">
            <h3>
              Reminders
              {pendingCount > 0 && (
                <span className="capture-page__col-count">{pendingCount}</span>
              )}
            </h3>
          </header>
          <div className="capture-page__col-body">
            <RemindersPage compact />
          </div>
        </section>
      </div>
    </div>
  );
}
