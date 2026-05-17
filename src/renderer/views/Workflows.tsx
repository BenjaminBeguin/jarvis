import { useEffect, useMemo, useState } from 'react';

import type { WorkflowDef, WorkflowRun } from '../../shared/types';
import { toast } from './Toaster';
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

type DockTab = 'json' | 'run';

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
      return;
    }
    setDraft(JSON.stringify(selected, null, 2));
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
            <WorkflowPipeline workflow={selected} run={recentRun} />
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
                  <RunDetail run={recentRun} />
                ))}
            </div>
          </div>
        )}
      </div>
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
          return (
            <li
              key={s.index}
              className={`workflows__step workflows__step--${s.status}`}
            >
              <span className="workflows__step-index">{s.index + 1}</span>
              <span className="workflows__step-type">{s.nodeType}</span>
              <span className="workflows__step-status">{s.status}</span>
              {stepDur && <span className="workflows__step-dur">{stepDur}</span>}
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
