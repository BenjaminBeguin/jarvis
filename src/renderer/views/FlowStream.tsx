import { Orb } from './flow/Orb';
import { Pipeline } from './flow/Pipeline';
import type { FlowEvent } from './flow/types';
import { useFlowStream } from './flow/useFlowStream';

/**
 * Live event river. Renders the static pipeline (stage gates) plus
 * one orb per in-flight or recently-completed event. Subscribes via
 * useFlowStream which merges task / reminder / inbox / notifier IPC
 * streams.
 *
 * Lives at /observatory (after the v2 sidebar rename — the old
 * Observatory is now AI Agent). Companion surface to AI Agent: where
 * AI Agent is "the list of runs", this is "the motion of right now".
 */

export function FlowStream() {
  const events = useFlowStream();

  const handleClick = (e: FlowEvent): void => {
    // Click-through targets per kind. Tasks go to the AI Agent tab
    // focused on that task; reminders to the Reminders page; inbox
    // scan back to Inbox; notifications navigate to their owning
    // task if available, else nowhere.
    if (e.kind === 'task') {
      window.dispatchEvent(
        new CustomEvent('jarvis:open-session', {
          detail: { taskId: e.entityId },
        }),
      );
      return;
    }
    if (e.kind === 'reminder') {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', {
          detail: { tab: 'inbox' },
        }),
      );
      return;
    }
    if (e.kind === 'inbox-scan') {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', {
          detail: { tab: 'inbox' },
        }),
      );
      return;
    }
    // Notification orb — if there's a backing task, peek the session.
    if (e.kind === 'notification' && /^[a-zA-Z0-9_-]{6,}$/.test(e.entityId)) {
      window.dispatchEvent(
        new CustomEvent('jarvis:open-session', {
          detail: { taskId: e.entityId },
        }),
      );
    }
  };

  return (
    <section className="flow-stream">
      <header className="flow-stream__head">
        <h2>OBSERVATORY</h2>
        <p className="flow-stream__hint">
          Live river of events flowing through Jarvis. Orbs enter at <em>trigger</em>,
          pass through each stage as they progress, and fade after they hit a terminal
          state. Color = source. Hover any orb for details · click to drill in.
        </p>
      </header>

      <div className="flow-stream__canvas">
        <svg
          viewBox="0 0 1000 600"
          preserveAspectRatio="xMidYMid meet"
          className="flow-stream__svg"
          aria-label="Live event flow"
        >
          <Pipeline />
          {events.map((e) => (
            <Orb key={e.id} event={e} onClick={handleClick} />
          ))}
        </svg>
      </div>

      <footer className="flow-stream__footer">
        <span className="flow-stream__legend">
          <Swatch color="var(--accent)" /> palette · <Swatch color="#7ad8ff" />{' '}
          voice · <Swatch color="#ffb454" /> cron · <Swatch color="#ff9ec7" />{' '}
          reminder · <Swatch color="#5fffa6" /> telegram ·{' '}
          <Swatch color="#9cb9e0" /> module ·{' '}
          <Swatch color="rgba(220,220,220,0.55)" /> notification
        </span>
        <span className="flow-stream__count">
          {events.filter((e) => e.status === 'in-flight').length} live ·{' '}
          {events.length} on the river
        </span>
      </footer>
    </section>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="flow-stream__swatch"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}
