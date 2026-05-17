import { useEffect, useMemo, useState } from 'react';

import type { WorkflowDef, WorkflowRun } from '../../shared/types';
import { toast } from './Toaster';
import { NodeDetail } from './workflows/NodeDetail';
import { WorkflowPipeline } from './workflows/WorkflowPipeline';
import { WorkflowSelector } from './workflows/WorkflowSelector';

/**
 * Workflows page — graph-first layout.
 *
 *   ┌─ Toolbar ────────────────────────────────────────────┐
 *   │ [▾ Workflow] [Disable] [Run] [Delete]      [open ▽] │
 *   ├──────────────────────────────────────────────────────┤
 *   │                                                       │
 *   │   React Flow canvas (the centerpiece)                │
 *   │                                                       │
 *   ├──────────────────────────────────────────────────────┤
 *   │ JSON / Latest run (collapsible bottom dock)          │
 *   └──────────────────────────────────────────────────────┘
 *
 * The left rail of workflows is gone — a small floating selector
 * replaces it. The graph takes whatever vertical space is left after
 * the toolbar and the (optional) bottom dock.
 */

type DockTab = 'json' | 'run' | 'step';

export function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [errors, setErrors] = useState<
    Array<{ filename: string; message: string }>
  >([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [recentRun, setRecentRun] = useState<WorkflowRun | null>(null);
  const [dockOpen, setDockOpen] = useState<boolean>(true);
  const [dockTab, setDockTab] = useState<DockTab>('json');
  const [selectedStepIdx, setSelectedStepIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const { workflows: list, errors: errs } = await window.jarvis.listWorkflows();
      if (cancelled) return;
      setWorkflows(list);
      setErrors(errs);
      if (!selectedId && list.length > 0) setSelectedId(list[0]!.id);
    };
    void refresh();
    const off = window.jarvis.onWorkflowsChanged((list) => {
      setWorkflows(list);
      void window.jarvis.listWorkflows().then((r) => setErrors(r.errors));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [selectedId]);

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) ?? null,
    [workflows, selectedId],
  );

  useEffect(() => {
    if (!selected) {
      setDraft('');
      setSelectedStepIdx(null);
      return;
    }
    setDraft(JSON.stringify(selected, null, 2));
    setSelectedStepIdx(null);
  }, [selected]);

  useEffect(() => {
    if (!selectedId) {
      setRecentRun(null);
      return;
    }
    let cancelled = false;
    void window.jarvis.listWorkflowRuns(selectedId).then((runs) => {
      if (cancelled) return;
      setRecentRun(runs[0] ?? null);
    });
    const off = window.jarvis.onWorkflowRunChanged((run) => {
      if (run.workflowId !== selectedId) return;
      setRecentRun(run);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [selectedId]);

  const save = async (): Promise<void> => {
    if (!selected) return;
    let parsed: WorkflowDef;
    try {
      parsed = JSON.parse(draft) as WorkflowDef;
    } catch (e) {
      toast({
        kind: 'error',
        message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const result = await window.jarvis.saveWorkflow(parsed);
    if (!result.ok) {
      toast({ kind: 'error', message: result.message ?? 'Save failed' });
      return;
    }
    toast({ message: `Saved · ${parsed.name}` });
  };

  const runNow = async (): Promise<void> => {
    if (!selected) return;
    const r = await window.jarvis.runWorkflow(selected.id);
    if (!r.ok) {
      toast({ kind: 'error', message: r.message ?? 'Run failed' });
    } else {
      toast({ message: `Running · ${selected.name}` });
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (
      !confirm(
        `Delete workflow "${selected.name}"? The file at ~/.jarvis/workflows/${selected.id}.json will be removed.`,
      )
    ) {
      return;
    }
    const ok = await window.jarvis.deleteWorkflow(selected.id);
    if (ok) {
      toast({ message: `Deleted · ${selected.name}` });
      setSelectedId(null);
    } else {
      toast({ kind: 'error', message: 'Delete failed' });
    }
  };

  const toggleEnabled = async (): Promise<void> => {
    if (!selected) return;
    const next: WorkflowDef = { ...selected, enabled: !selected.enabled };
    await window.jarvis.saveWorkflow(next);
  };

  return (
    <section className="wf-page">
      <header className="wf-toolbar">
        <WorkflowSelector
          workflows={workflows}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        {selected && (
          <div className="wf-toolbar__actions">
            <span className="wf-toolbar__trigger">
              {triggerLabel(selected.trigger)}
            </span>
            <button onClick={() => void toggleEnabled()}>
              {selected.enabled ? 'Disable' : 'Enable'}
            </button>
            <button onClick={() => void runNow()} className="wf-toolbar__run">
              Run now
            </button>
            <button
              onClick={() => void remove()}
              className="wf-toolbar__delete"
            >
              Delete
            </button>
          </div>
        )}
        <div className="wf-toolbar__spacer" />
        <button
          type="button"
          className="wf-toolbar__dock-toggle"
          onClick={() => setDockOpen((v) => !v)}
          aria-pressed={dockOpen}
          title={dockOpen ? 'Hide details' : 'Show details'}
        >
          {dockOpen ? 'Hide details ▾' : 'Show details ▴'}
        </button>
      </header>

      {errors.length > 0 && (
        <div className="wf-banner">
          {errors.map((e) => (
            <div key={e.filename} className="wf-banner__item">
              <strong>{e.filename}</strong>
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className={`wf-body${dockOpen ? '' : ' wf-body--dock-closed'}`}>
        <div className="wf-graph">
          {!selected ? (
            <div className="wf-graph__empty">
              Pick a workflow above. Built-ins live in{' '}
              <code>~/.jarvis/workflows/</code>; drop a new JSON file there and
              it shows up here.
            </div>
          ) : (
            <WorkflowPipeline
              workflow={selected}
              run={recentRun}
              selectedIndex={selectedStepIdx}
              onNodeClick={(i) => {
                setSelectedStepIdx(i);
                setDockOpen(true);
                setDockTab('step');
              }}
            />
          )}
        </div>

        {selected && dockOpen && (
          <div className="wf-dock">
            <div className="wf-dock__tabs">
              <button
                type="button"
                className={`wf-dock__tab${dockTab === 'json' ? ' wf-dock__tab--active' : ''}`}
                onClick={() => setDockTab('json')}
              >
                JSON
              </button>
              <button
                type="button"
                className={`wf-dock__tab${dockTab === 'run' ? ' wf-dock__tab--active' : ''}`}
                onClick={() => setDockTab('run')}
              >
                Latest run{' '}
                {recentRun && (
                  <span
                    className={`wf-dock__tab-status wf-dock__tab-status--${recentRun.status}`}
                  >
                    · {recentRun.status}
                  </span>
                )}
              </button>
              {selectedStepIdx !== null && (
                <button
                  type="button"
                  className={`wf-dock__tab${dockTab === 'step' ? ' wf-dock__tab--active' : ''}`}
                  onClick={() => setDockTab('step')}
                >
                  Step {selectedStepIdx + 1}
                  {recentRun?.steps[selectedStepIdx] && (
                    <span
                      className={`wf-dock__tab-status wf-dock__tab-status--${recentRun.steps[selectedStepIdx]!.status}`}
                    >
                      · {recentRun.steps[selectedStepIdx]!.status}
                    </span>
                  )}
                </button>
              )}
              <div className="wf-dock__spacer" />
              {dockTab === 'json' && (
                <button
                  type="button"
                  className="wf-dock__save"
                  onClick={() => void save()}
                >
                  Save (⌘S)
                </button>
              )}
            </div>
            <div className="wf-dock__body">
              {dockTab === 'json' && (
                <textarea
                  className="wf-dock__textarea"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  spellCheck={false}
                />
              )}
              {dockTab === 'run' &&
                (!recentRun ? (
                  <div className="wf-dock__empty">
                    No runs yet. Hit Run now or wait for the trigger to fire.
                  </div>
                ) : (
                  <RunDetail
                    run={recentRun}
                    selectedIndex={selectedStepIdx}
                    onSelectStep={(i) => {
                      setSelectedStepIdx(i);
                      setDockTab('step');
                    }}
                  />
                ))}
              {dockTab === 'step' && selectedStepIdx !== null && selected && (
                <StepInspector
                  workflow={selected}
                  run={recentRun}
                  index={selectedStepIdx}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function triggerLabel(t: WorkflowDef['trigger']): string {
  if (t.kind === 'cron') return `cron · ${t.every}`;
  return `manual${t.palette ? ' · ' + t.palette : ''}`;
}

function RunDetail({
  run,
  selectedIndex,
  onSelectStep,
}: {
  run: WorkflowRun;
  selectedIndex: number | null;
  onSelectStep: (i: number) => void;
}) {
  const dur =
    run.endedAt != null ? `${run.endedAt - run.startedAt}ms` : 'running…';
  return (
    <div className="workflows__run-detail">
      <div className="workflows__run-meta">
        <span
          className={`workflows__run-status workflows__run-status--${run.status}`}
        >
          {run.status}
        </span>
        <span>{new Date(run.startedAt).toLocaleString()}</span>
        <span>{dur}</span>
        <span>· {run.trigger}</span>
      </div>
      <ol className="workflows__steps">
        {run.steps.map((s) => {
          const stepDur =
            s.endedAt != null && s.startedAt > 0
              ? `${s.endedAt - s.startedAt}ms`
              : s.status === 'running'
                ? '…'
                : '';
          const hasOutput = s.output !== undefined;
          const isSelected = selectedIndex === s.index;
          return (
            <li
              key={s.index}
              className={`workflows__step workflows__step--${s.status}${isSelected ? ' workflows__step--selected' : ''}${hasOutput ? ' workflows__step--clickable' : ''}`}
              onClick={hasOutput ? () => onSelectStep(s.index) : undefined}
              role={hasOutput ? 'button' : undefined}
              tabIndex={hasOutput ? 0 : undefined}
              title={hasOutput ? 'Click to inspect output' : undefined}
            >
              <span className="workflows__step-index">{s.index + 1}</span>
              <span className="workflows__step-type">{s.nodeType}</span>
              <span className="workflows__step-status">{s.status}</span>
              {stepDur && <span className="workflows__step-dur">{stepDur}</span>}
              {hasOutput && (
                <span className="workflows__step-peek">view output →</span>
              )}
              {s.error && (
                <span className="workflows__step-error">{s.error}</span>
              )}
            </li>
          );
        })}
      </ol>
      {run.error && <div className="workflows__run-error">{run.error}</div>}
    </div>
  );
}

/**
 * Renders the output of a single step. Hits the `step` tab in the
 * dock; opened by clicking a node in the graph or a step row in the
 * Latest-run tab.
 */
function StepInspector({
  workflow,
  run,
  index,
}: {
  workflow: WorkflowDef;
  run: WorkflowRun | null;
  index: number;
}) {
  const node = workflow.pipeline[index];
  const step = run?.steps[index];
  const dur =
    step && step.endedAt != null && step.startedAt > 0
      ? `${step.endedAt - step.startedAt}ms`
      : null;

  return (
    <div className="wf-step-inspector">
      <header className="wf-step-inspector__head">
        <span className="wf-step-inspector__index">step {index + 1}</span>
        <span className="wf-step-inspector__type">{node?.type ?? '?'}</span>
        {step && (
          <span
            className={`wf-step-inspector__status wf-step-inspector__status--${step.status}`}
          >
            {step.status}
          </span>
        )}
        {dur && <span className="wf-step-inspector__dur">{dur}</span>}
        {step?.outputTruncated && (
          <span className="wf-step-inspector__warn">
            output truncated (over 100KB)
          </span>
        )}
      </header>
      <div className="wf-step-inspector__body">
        {node && (
          <section className="wf-step-inspector__section">
            <h4 className="wf-step-inspector__section-title">Configuration</h4>
            <NodeDetail node={node} />
          </section>
        )}
        <section className="wf-step-inspector__section">
          <h4 className="wf-step-inspector__section-title">Output</h4>
          {!step ? (
            <div className="wf-dock__empty">
              No run data yet. Run the workflow to capture this step's
              output.
            </div>
          ) : step.error ? (
            <pre className="wf-step-inspector__pre wf-step-inspector__pre--error">
              {step.error}
            </pre>
          ) : step.output === undefined ? (
            <div className="wf-dock__empty">
              {step.status === 'pending' || step.status === 'running'
                ? 'Step hasn’t produced output yet.'
                : step.status === 'skipped'
                  ? 'Step was skipped — no output captured.'
                  : 'No output recorded for this step.'}
            </div>
          ) : (
            <pre className="wf-step-inspector__pre">
              {formatOutput(step.output)}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}

function formatOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
