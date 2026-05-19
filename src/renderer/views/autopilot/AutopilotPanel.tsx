import { useEffect, useMemo, useState } from 'react';

import type {
  AppMode,
  WorkflowDef,
  WorkflowRun,
} from '../../../shared/types';
import { toast } from '../Toaster';

/**
 * Settings → Autopilot panel.
 *
 * Two purposes:
 *
 * 1. Surface the tri-state mode picker in a second place, with
 *    explanatory copy. The tray menu + header have the toggle too,
 *    but Settings is where a new user reads what each mode does.
 *
 * 2. Show the feedback trail per autopilot workflow so the user can
 *    see what they've accepted / rejected — the prompt-output node
 *    appends every decision to ~/.jarvis/autopilot/feedback/<id>.md
 *    and the agent reads it on the next run.
 */

interface FeedbackEntry {
  ts: number;
  decision: 'ACCEPTED' | 'REJECTED';
  context?: string;
  drafted?: string;
  feedback?: string;
}

export function AutopilotPanel() {
  const [mode, setMode] = useState<AppMode>('running');
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [runs, setRuns] = useState<Map<string, WorkflowRun[]>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.getAppMode().then((m) => {
      if (!cancelled) setMode(m);
    });
    const off = window.jarvis.onAppModeChanged((m) => setMode(m));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const { workflows: list } = await window.jarvis.listWorkflows();
      if (cancelled) return;
      setWorkflows(list);
    };
    void refresh();
    const off = window.jarvis.onWorkflowsChanged(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Pull the 5 most recent runs per autopilot workflow so users see
  // recency at a glance under each card.
  useEffect(() => {
    let cancelled = false;
    const autopilots = workflows.filter(
      (w) => w.trigger.kind === 'autopilot',
    );
    void Promise.all(
      autopilots.map(async (w) => {
        const list = await window.jarvis.listWorkflowRuns(w.id);
        return [w.id, list.slice(0, 5)] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setRuns(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [workflows]);

  const autopilots = useMemo(
    () => workflows.filter((w) => w.trigger.kind === 'autopilot'),
    [workflows],
  );

  const toggleWorkflow = async (def: WorkflowDef): Promise<void> => {
    const next = { ...def, enabled: !def.enabled };
    const result = await window.jarvis.saveWorkflow(next);
    if (!result.ok) {
      toast({
        kind: 'error',
        message: result.message ?? 'Save failed',
      });
    }
  };

  return (
    <div className="settings__section autopilot-panel">
      <header className="autopilot-panel__head">
        <h3>Autopilot</h3>
        <p className="autopilot-panel__desc">
          Three operating modes. Pick one — only autopilot fires the
          scenarios below. Feedback you give in the approval HUD
          accumulates per scenario and shapes the next run's draft.
        </p>
      </header>

      <ModePicker mode={mode} onChange={(m) => void window.jarvis.setAppMode(m)} />

      <h4 className="autopilot-panel__sub">Scenarios</h4>
      {autopilots.length === 0 ? (
        <div className="autopilot-panel__empty">
          No autopilot scenarios installed. Built-in seeds live under{' '}
          <code>~/.jarvis/workflows/</code>; check that{' '}
          <code>autopilot-*</code> JSON files are present.
        </div>
      ) : (
        <div className="autopilot-panel__scenarios">
          {autopilots.map((w) => (
            <ScenarioCard
              key={w.id}
              workflow={w}
              recentRuns={runs.get(w.id) ?? []}
              onToggle={() => void toggleWorkflow(w)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModePicker({
  mode,
  onChange,
}: {
  mode: AppMode;
  onChange: (next: AppMode) => void;
}) {
  return (
    <div className="autopilot-panel__modes" role="radiogroup">
      {(
        [
          {
            value: 'paused',
            label: '⏸ Paused',
            blurb: 'Silence routines, scheduled actions, and autopilot.',
          },
          {
            value: 'running',
            label: '▶ Running',
            blurb: 'Normal behavior. Confirmations apply.',
          },
          {
            value: 'autopilot',
            label: '⚡ Autopilot',
            blurb:
              'Less friction (auto-confirm prompts) + proactive scenarios fire on schedule / events.',
          },
        ] as Array<{ value: AppMode; label: string; blurb: string }>
      ).map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={mode === opt.value}
          className={`autopilot-panel__mode autopilot-panel__mode--${opt.value}${
            mode === opt.value ? ' autopilot-panel__mode--on' : ''
          }`}
          onClick={() => onChange(opt.value)}
        >
          <span className="autopilot-panel__mode-label">{opt.label}</span>
          <span className="autopilot-panel__mode-blurb">{opt.blurb}</span>
        </button>
      ))}
    </div>
  );
}

function ScenarioCard({
  workflow,
  recentRuns,
  onToggle,
}: {
  workflow: WorkflowDef;
  recentRuns: WorkflowRun[];
  onToggle: () => void;
}) {
  const [feedback, setFeedback] = useState<FeedbackEntry[] | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const loadFeedback = async (): Promise<void> => {
    const list = (await window.jarvis.autopilotFeedback('list', workflow.id)) as FeedbackEntry[];
    setFeedback(list);
  };

  const clearFeedback = async (): Promise<void> => {
    if (
      !confirm(
        `Clear feedback history for "${workflow.name}"? Past accept / reject decisions will be erased and the agent's next run gets a clean slate.`,
      )
    ) {
      return;
    }
    await window.jarvis.autopilotFeedback('clear', workflow.id);
    await loadFeedback();
    toast({ message: `Cleared · ${workflow.name}` });
  };

  useEffect(() => {
    if (feedbackOpen && feedback === null) void loadFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackOpen]);

  const trigger = workflow.trigger;
  const triggerText =
    trigger.kind === 'autopilot'
      ? trigger.when === 'cron'
        ? `every ${trigger.every ?? '?'}`
        : `on ${(trigger.sources ?? []).join(', ') || 'inbox'}`
      : '?';

  return (
    <article
      className={`autopilot-card${workflow.enabled ? ' autopilot-card--on' : ''}`}
    >
      <header className="autopilot-card__head">
        <div className="autopilot-card__title-block">
          <span className="autopilot-card__name">{workflow.name}</span>
          <span className="autopilot-card__meta">
            <code>{workflow.id}</code> · {triggerText} · {workflow.pipeline.length}{' '}
            step{workflow.pipeline.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          type="button"
          className={`autopilot-card__toggle${workflow.enabled ? ' autopilot-card__toggle--on' : ''}`}
          onClick={onToggle}
          aria-pressed={workflow.enabled}
        >
          {workflow.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </header>
      {workflow.description && (
        <p className="autopilot-card__desc">{workflow.description}</p>
      )}
      <div className="autopilot-card__stats">
        <span className="autopilot-card__stat">
          {recentRuns.length === 0
            ? 'No runs yet'
            : `${recentRuns.filter((r) => r.status === 'completed').length}/${recentRuns.length} successful (last ${recentRuns.length})`}
        </span>
        <button
          type="button"
          className="autopilot-card__feedback-btn"
          onClick={() => setFeedbackOpen((v) => !v)}
          aria-expanded={feedbackOpen}
        >
          {feedbackOpen ? '▾ Feedback trail' : '▸ Feedback trail'}
        </button>
      </div>
      {feedbackOpen && (
        <div className="autopilot-card__feedback">
          {feedback === null ? (
            <div className="autopilot-card__feedback-empty">Loading…</div>
          ) : feedback.length === 0 ? (
            <div className="autopilot-card__feedback-empty">
              No feedback yet. Decisions land here once you approve / reject
              an autopilot draft for this scenario.
            </div>
          ) : (
            <>
              <ul className="autopilot-card__feedback-list">
                {feedback.map((entry, i) => (
                  <li
                    key={i}
                    className={`autopilot-card__feedback-row autopilot-card__feedback-row--${entry.decision.toLowerCase()}`}
                  >
                    <span className="autopilot-card__feedback-decision">
                      {entry.decision === 'ACCEPTED' ? '✓' : '✕'}{' '}
                      {entry.decision.toLowerCase()}
                    </span>
                    <span className="autopilot-card__feedback-ts">
                      {entry.ts ? new Date(entry.ts).toLocaleString() : ''}
                    </span>
                    {entry.feedback && (
                      <div className="autopilot-card__feedback-note">
                        {entry.feedback}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="autopilot-card__feedback-clear"
                onClick={() => void clearFeedback()}
              >
                Clear history
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
