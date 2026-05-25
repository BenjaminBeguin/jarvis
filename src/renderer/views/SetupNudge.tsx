import { useEffect, useState } from 'react';

import type { AppStatus, ConnectorSummary, WorkflowDef } from '../../shared/types';

/**
 * Slim banner shown at the top of Working mode when the user has
 * critical setup gaps. Quietly disappears once everything's in place.
 *
 * Heuristic — show only when at least ONE of these is missing:
 *   - auth (no signed-in mode)
 *   - any of the three major integrations (google, slack, github)
 *   - any enabled autopilot workflow
 *
 * Less critical items (working hours, policy customization) still
 * surface in the Setup checklist itself, but don't trigger the nudge.
 *
 * Dismissable for the session — the close button hides it until the
 * user reopens the app. Storing in sessionStorage instead of
 * localStorage so each launch re-evaluates.
 */

const DISMISSED_KEY = 'jarvis.setupNudgeDismissed';

function isDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function setDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // ignore
  }
}

interface Props {
  onSwitchToSetup: () => void;
}

export function SetupNudge({ onSwitchToSetup }: Props) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [integrations, setIntegrations] = useState<ConnectorSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [dismissed, setDismissedState] = useState<boolean>(() => isDismissed());

  useEffect(() => {
    const refresh = async () => {
      try {
        const [s, ints, wf] = await Promise.all([
          window.jarvis.getStatus(),
          window.jarvis.listIntegrations(),
          window.jarvis.listWorkflows().then((r) => r.workflows),
        ]);
        setStatus(s);
        setIntegrations(ints);
        setWorkflows(wf);
      } catch {
        // benign — banner just won't show if we can't read state
      }
    };
    void refresh();
    const offInts = window.jarvis.onIntegrationsChanged(refresh);
    const offWf = window.jarvis.onWorkflowsChanged(() => void refresh());
    return () => {
      offInts();
      offWf();
    };
  }, []);

  if (dismissed) return null;
  if (!status) return null;

  const authDone =
    (status.authMode === 'subscription' && status.hasSubscriptionToken) ||
    (status.authMode === 'api-key' && status.hasApiKey);

  const importantConnectors = ['google', 'slack', 'github'];
  const connectedCount = importantConnectors.filter((id) => {
    const conn = integrations.find((c) => c.id === id);
    return (conn?.accounts ?? []).length > 0;
  }).length;

  const enabledAutopilots = workflows.filter(
    (w) => w.trigger.kind === 'autopilot' && w.enabled,
  );

  // Tally only the high-impact pending items.
  const pending: string[] = [];
  if (!authDone) pending.push('sign in');
  if (connectedCount === 0) pending.push('connect an account');
  if (enabledAutopilots.length === 0) {
    pending.push('enable a triage workflow');
  }

  if (pending.length === 0) return null;

  return (
    <div className="setup-nudge" role="status">
      <span className="setup-nudge__icon" aria-hidden>
        ⚙
      </span>
      <span className="setup-nudge__text">
        Jarvis needs a moment — {pending.join(' · ')}.
      </span>
      <button
        type="button"
        className="setup-nudge__action"
        onClick={onSwitchToSetup}
      >
        Open Setup
      </button>
      <button
        type="button"
        className="setup-nudge__dismiss"
        onClick={() => {
          setDismissed();
          setDismissedState(true);
        }}
        title="Dismiss until next launch"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
