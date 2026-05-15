import { useEffect, useState } from 'react';

import type { Reminder } from '../../shared/types';
import { QuickNotePage } from './QuickNotePage';
import { RemindersPage } from './RemindersPage';

/**
 * Capture surface — one page, two tabs: Notes and Reminders.
 *
 * Both surfaces are "things I jot for myself" — notes are free-form,
 * reminders are time-pressured. Merging them into one module page
 * cuts the "where did I put that" confusion and means the user has a
 * single hub for capture / to-do management.
 *
 * Tab state is local. Two ways to set the initial tab:
 *   - `initial` prop — used by MODULE_PAGES wiring (the /reminders
 *     palette intent passes 'reminders'; the /note + Pages sub-nav
 *     entry pass 'notes').
 *   - 'jarvis:capture-tab' window event — fired by Shell.applyNav when
 *     a verbal/IPC nav payload carries `captureTab`. Lets the user
 *     reach the right tab without re-navigating.
 *
 * Both inner pages render with `compact` so their h2/page-header is
 * suppressed — we provide a unified header + tab switcher here.
 */

type CaptureTab = 'notes' | 'reminders';

interface Props {
  initial?: CaptureTab;
}

export function CapturePage({ initial = 'notes' }: Props = {}) {
  const [tab, setTab] = useState<CaptureTab>(initial);
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    void window.jarvis.listReminders().then(setReminders);
    return window.jarvis.onRemindersChanged(setReminders);
  }, []);

  useEffect(() => {
    const onFocusTab = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: CaptureTab };
      if (detail?.tab === 'notes' || detail?.tab === 'reminders') {
        setTab(detail.tab);
      }
    };
    window.addEventListener('jarvis:capture-tab', onFocusTab);
    return () => window.removeEventListener('jarvis:capture-tab', onFocusTab);
  }, []);

  // Reminder count shown in the tab — fired + pending count is the
  // "needs attention" number (mirrors the inbox source filter).
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
        <div className="capture-page__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'notes'}
            className={`capture-page__tab${
              tab === 'notes' ? ' capture-page__tab--active' : ''
            }`}
            onClick={() => setTab('notes')}
          >
            Notes
          </button>
          <button
            role="tab"
            aria-selected={tab === 'reminders'}
            className={`capture-page__tab${
              tab === 'reminders' ? ' capture-page__tab--active' : ''
            }`}
            onClick={() => setTab('reminders')}
          >
            Reminders
            {pendingCount > 0 && (
              <span className="capture-page__tab-count">{pendingCount}</span>
            )}
          </button>
        </div>
      </header>
      <div className="capture-page__body">
        {tab === 'notes' ? (
          <QuickNotePage compact />
        ) : (
          <RemindersPage compact />
        )}
      </div>
    </div>
  );
}
