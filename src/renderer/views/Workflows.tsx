import { useEffect, useMemo, useState } from 'react';

import type { WorkflowDef, WorkflowRun } from '../../shared/types';
import { toast } from './Toaster';
import { WorkflowPipeline } from './workflows/WorkflowPipeline';

/**
 * Workflows tab — list every workflow loaded from
 * `~/.jarvis/workflows/*.json`, plus a detail view for the selected
 * one (JSON editor + most-recent run).
 *
 * No visual node editor in V1. The JSON shape is small and a power
 * user can read it; we save back via the IPC `saveWorkflow` channel
 * which writes the file + re-broadcasts.
 *
 * Each workflow is one trigger + a linear pipeline of nodes. The
 * scheduler reads the file on every save and re-registers cron jobs
 * if `trigger.kind === 'cron'`.
 */
export function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [errors, setErrors] = useState<
    Array<{ filename: string; message: string }>
  >([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [recentRun, setRecentRun] = useState<WorkflowRun | null>(null);

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
      // The errors broadcast piggy-backs the changed event in V1 —
      // re-fetch to pick up the latest.
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

  // Reset the JSON editor whenever the selected workflow changes.
  useEffect(() => {
    if (!selected) {
      setDraft('');
      return;
    }
    setDraft(JSON.stringify(selected, null, 2));
  }, [selected]);

  // Live-track the most recent run for this workflow.
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
    <section className="briefings">
      <aside className="briefings__rail">
        <h2 className="briefings__rail-head">WORKFLOWS</h2>
        <p className="briefings__rail-hint">
          Triggers + pipelines of nodes. Each workflow lives as JSON
          under <code>~/.jarvis/workflows/</code>. Edit on the right
          panel; the file watcher picks up external edits too.
        </p>
        {errors.length > 0 && (
          <div className="workflows__errors">
            {errors.map((e) => (
              <div key={e.filename} className="workflows__error">
                <strong>{e.filename}</strong>
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        )}
        <ul className="briefings__list">
          {workflows.length === 0 && (
            <li className="briefings__empty">No workflows yet.</li>
          )}
          {workflows.map((w) => {
            const isActive = w.id === selectedId;
            return (
              <li key={w.id}>
                <button
                  className={`briefings__kind${isActive ? ' briefings__kind--active' : ''}${w.enabled ? '' : ' routines__rail-card--off'}`}
                  onClick={() => setSelectedId(w.id)}
                  title={w.description ?? w.id}
                >
                  <div className="briefings__kind-label">
                    <span
                      className="briefings__kind-on-dot"
                      style={{
                        background: w.enabled ? 'var(--good)' : 'var(--text-faint)',
                      }}
                      aria-hidden
                    />
                    {w.name}
                  </div>
                  {w.description && (
                    <div className="briefings__kind-desc">{w.description}</div>
                  )}
                  <div className="briefings__kind-schedule">
                    {triggerLabel(w.trigger)} · {w.pipeline.length} node
                    {w.pipeline.length === 1 ? '' : 's'}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="briefings__main">
        {!selected && (
          <div className="briefings__placeholder">
            Pick a workflow on the left. Built-ins live in
            <code>~/.jarvis/workflows/</code>; drop a new JSON file
            there and it shows up here.
          </div>
        )}
        {selected && (
          <>
            <header className="briefings__main-head">
              <h2>{selected.name}</h2>
              <div className="routine-detail__actions">
                <button onClick={() => void toggleEnabled()}>
                  {selected.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => void runNow()}>Run now</button>
                <button onClick={() => void remove()} className="routine-detail__delete">
                  Delete
                </button>
              </div>
            </header>

            <WorkflowPipeline
              workflow={selected}
              run={recentRun}
              trigger={selected.trigger}
            />

            <div className="workflows__detail">
              <section className="workflows__editor">
                <div className="workflows__editor-head">
                  <h3>JSON</h3>
                  <button
                    className="workflows__save"
                    onClick={() => void save()}
                  >
                    Save (⌘S)
                  </button>
                </div>
                <textarea
                  className="workflows__textarea"
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
              </section>

              <section className="workflows__run">
                <h3>Latest run</h3>
                {!recentRun ? (
                  <div className="workflows__run-empty">
                    No runs yet. Hit Run now or wait for the trigger
                    to fire.
                  </div>
                ) : (
                  <RunDetail run={recentRun} />
                )}
              </section>
            </div>
          </>
        )}
      </main>
    </section>
  );
}

function triggerLabel(t: WorkflowDef['trigger']): string {
  if (t.kind === 'cron') return `cron · ${t.every}`;
  if (t.kind === 'manual') return `manual${t.palette ? ' · ' + t.palette : ''}`;
  return `event · ${t.topic}`;
}

function RunDetail({ run }: { run: WorkflowRun }) {
  const dur =
    run.endedAt != null ? `${run.endedAt - run.startedAt}ms` : 'running…';
  return (
    <div className="workflows__run-detail">
      <div className="workflows__run-meta">
        <span className={`workflows__run-status workflows__run-status--${run.status}`}>
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
          return (
            <li
              key={s.index}
              className={`workflows__step workflows__step--${s.status}`}
            >
              <span className="workflows__step-index">{s.index + 1}</span>
              <span className="workflows__step-type">{s.nodeType}</span>
              <span className="workflows__step-status">{s.status}</span>
              {stepDur && (
                <span className="workflows__step-dur">{stepDur}</span>
              )}
              {s.error && <span className="workflows__step-error">{s.error}</span>}
            </li>
          );
        })}
      </ol>
      {run.error && <div className="workflows__run-error">{run.error}</div>}
    </div>
  );
}
