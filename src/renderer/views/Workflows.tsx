import { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkflowDef, WorkflowNodeDef, WorkflowRun } from '../../shared/types';
import { toast } from './Toaster';
import { NodeDetail } from './workflows/NodeDetail';
import { NODE_TEMPLATES, emptyWorkflow } from './workflows/nodePalette';
import {
  WorkflowPipeline,
  type WorkflowSelection,
} from './workflows/WorkflowPipeline';
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

type DockTab = 'json' | 'run' | 'step' | 'chat';

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
  const [selectedNode, setSelectedNode] = useState<WorkflowSelection | null>(
    null,
  );
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const [chatPrompt, setChatPrompt] = useState<string>('');
  const [chatBusy, setChatBusy] = useState<boolean>(false);
  const [chatRunId, setChatRunId] = useState<string | null>(null);
  // Auto-close the palette popover on outside click.
  useEffect(() => {
    if (!paletteOpen) return undefined;
    const onClick = (e: MouseEvent): void => {
      if (!paletteRef.current) return;
      if (paletteRef.current.contains(e.target as Node)) return;
      setPaletteOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [paletteOpen]);

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
      setSelectedNode(null);
      return;
    }
    setDraft(JSON.stringify(selected, null, 2));
    setSelectedNode(null);
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

  /**
   * Append a fresh stub of the requested node type to the selected
   * workflow's pipeline and persist. The dock auto-switches to JSON
   * so the user can fine-tune the stub (URLs, args, etc.) — most
   * templates start with placeholders that the workflow can't run
   * usefully without editing.
   */
  const addNode = async (stub: WorkflowNodeDef): Promise<void> => {
    if (!selected) return;
    const next: WorkflowDef = {
      ...selected,
      pipeline: [...selected.pipeline, stub],
    };
    const result = await window.jarvis.saveWorkflow(next);
    if (!result.ok) {
      toast({ kind: 'error', message: result.message ?? 'Add failed' });
      return;
    }
    setPaletteOpen(false);
    setDraft(JSON.stringify(next, null, 2));
    setDockOpen(true);
    setDockTab('json');
    toast({
      message: `+ ${stub.type} step appended — edit the params in the JSON dock`,
    });
  };

  /**
   * Send a natural-language instruction to the workflow-author skill.
   * The skill reads the selected workflow's JSON file (if any), edits
   * or composes a new one, and writes it back. The file watcher picks
   * up the change → workflow list refreshes and the editor reloads.
   */
  const sendChat = async (): Promise<void> => {
    const prompt = chatPrompt.trim();
    if (!prompt) return;
    setChatBusy(true);
    setChatRunId(null);
    try {
      const sel = selected?.id ?? '';
      const framed = sel
        ? `SELECTED_WORKFLOW_ID: ${sel}\n\nUser request:\n${prompt}`
        : `No workflow currently selected.\n\nUser request:\n${prompt}`;
      const task = await window.jarvis.launchTask({
        prompt: framed,
        skillId: 'workflow-author',
        origin: 'palette',
      });
      setChatRunId(task.id);
      setChatPrompt('');
      toast({
        message: 'Workflow-author started — watch the dock for the result',
      });
    } finally {
      setChatBusy(false);
    }
  };

  /**
   * Create a fresh empty workflow and select it. The user provides a
   * name, we derive an id from it. The workflow starts disabled with
   * a manual trigger so it doesn't fire by mistake before being
   * configured.
   */
  const createWorkflow = async (): Promise<void> => {
    const name = prompt(
      'New workflow name (used as the title — id is auto-derived):',
    );
    if (!name || !name.trim()) return;
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const id = slug || `workflow-${Date.now()}`;
    if (workflows.some((w) => w.id === id)) {
      toast({
        kind: 'error',
        message: `A workflow with id "${id}" already exists`,
      });
      return;
    }
    const stub = emptyWorkflow(id, name.trim());
    const result = await window.jarvis.saveWorkflow(stub as WorkflowDef);
    if (!result.ok) {
      toast({ kind: 'error', message: result.message ?? 'Create failed' });
      return;
    }
    setSelectedId(id);
    toast({ message: `Created ${name}` });
  };

  return (
    <section className="wf-page">
      <header className="wf-toolbar">
        <WorkflowSelector
          workflows={workflows}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <button
          type="button"
          onClick={() => void createWorkflow()}
          title="Create a new empty workflow"
        >
          + New
        </button>
        {selected && (
          <div className="wf-toolbar__actions">
            <span className="wf-toolbar__trigger">
              {triggerLabel(selected.trigger)}
            </span>
            <div className="wf-palette" ref={paletteRef}>
              <button
                type="button"
                onClick={() => setPaletteOpen((v) => !v)}
                aria-expanded={paletteOpen}
                title="Append a new step"
              >
                + Add node {paletteOpen ? '▾' : '▸'}
              </button>
              {paletteOpen && (
                <div className="wf-palette__menu" role="menu">
                  {NODE_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.type}
                      type="button"
                      className="wf-palette__item"
                      onClick={() => void addNode(tpl.template())}
                    >
                      <span className="wf-palette__item-head">
                        <strong>{tpl.label}</strong>
                        <span className="wf-palette__item-group">
                          {tpl.group}
                        </span>
                      </span>
                      <span className="wf-palette__item-desc">
                        {tpl.description}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
              selected={selectedNode}
              onSelect={(sel) => {
                setSelectedNode(sel);
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
              {selectedNode && (
                <button
                  type="button"
                  className={`wf-dock__tab${dockTab === 'step' ? ' wf-dock__tab--active' : ''}`}
                  onClick={() => setDockTab('step')}
                >
                  {selectedNode.kind === 'trigger' ? (
                    'Trigger'
                  ) : (
                    <>
                      Step {selectedNode.index + 1}
                      {recentRun?.steps[selectedNode.index] && (
                        <span
                          className={`wf-dock__tab-status wf-dock__tab-status--${recentRun.steps[selectedNode.index]!.status}`}
                        >
                          · {recentRun.steps[selectedNode.index]!.status}
                        </span>
                      )}
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                className={`wf-dock__tab${dockTab === 'chat' ? ' wf-dock__tab--active' : ''}`}
                onClick={() => setDockTab('chat')}
                title="Describe a workflow in natural language; the agent edits the JSON for you"
              >
                Chat ✦
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
                  <RunDetail
                    run={recentRun}
                    selectedIndex={
                      selectedNode?.kind === 'step' ? selectedNode.index : null
                    }
                    onSelectStep={(i) => {
                      setSelectedNode({ kind: 'step', index: i });
                      setDockTab('step');
                    }}
                  />
                ))}
              {dockTab === 'step' && selectedNode && selected && (
                selectedNode.kind === 'trigger' ? (
                  <TriggerInspector workflow={selected} run={recentRun} />
                ) : (
                  <StepInspector
                    workflow={selected}
                    run={recentRun}
                    index={selectedNode.index}
                  />
                )
              )}
              {dockTab === 'chat' && (
                <div className="wf-dock__chat">
                  <p className="wf-dock__chat-hint">
                    Describe what you want this workflow to do (or how to
                    change the current one) and the agent will edit the JSON
                    for you. The file watcher reloads the editor when it
                    finishes.
                  </p>
                  <textarea
                    className="wf-dock__chat-input"
                    value={chatPrompt}
                    onChange={(e) => setChatPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void sendChat();
                      }
                    }}
                    placeholder={
                      selected
                        ? `e.g. “add a cron every 15m and a notify step at the end”`
                        : `e.g. “build a workflow that fetches my GitHub notifications every 10m and writes them to the inbox”`
                    }
                    spellCheck={false}
                    rows={4}
                    disabled={chatBusy}
                  />
                  <div className="wf-dock__chat-bar">
                    <span className="wf-dock__chat-meta">
                      {selected
                        ? `Editing ${selected.id}`
                        : 'No workflow selected — agent will create a new one'}
                    </span>
                    <div className="wf-dock__spacer" />
                    {chatRunId && (
                      <span className="wf-dock__chat-run">
                        Task: <code>{chatRunId.slice(0, 8)}</code>
                      </span>
                    )}
                    <button
                      type="button"
                      className="wf-dock__chat-send"
                      onClick={() => void sendChat()}
                      disabled={chatBusy || chatPrompt.trim().length === 0}
                    >
                      {chatBusy ? 'Launching…' : 'Send (⌘↩)'}
                    </button>
                  </div>
                </div>
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
          // Errored rows are clickable even without a captured output —
          // the inspector falls back to the run-level error.
          const clickable = hasOutput || s.status === 'errored';
          const isSelected = selectedIndex === s.index;
          return (
            <li
              key={s.index}
              className={`workflows__step workflows__step--${s.status}${isSelected ? ' workflows__step--selected' : ''}${clickable ? ' workflows__step--clickable' : ''}`}
              onClick={clickable ? () => onSelectStep(s.index) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              title={
                clickable
                  ? s.status === 'errored'
                    ? 'Click to inspect error'
                    : 'Click to inspect output'
                  : undefined
              }
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
          <h4 className="wf-step-inspector__section-title">
            {step?.status === 'errored' ? 'Error' : 'Output'}
          </h4>
          {!step ? (
            <div className="wf-dock__empty">
              No run data yet. Run the workflow to capture this step's
              output.
            </div>
          ) : step.error ? (
            <pre className="wf-step-inspector__pre wf-step-inspector__pre--error">
              {step.error}
            </pre>
          ) : step.status === 'errored' ? (
            // Errored step but the per-step error wasn't captured —
            // either an older run from before step-error tracking
            // landed, or an XState transition that didn't carry an
            // `error` event. Fall back to the run-level message so the
            // inspector isn't a dead end.
            <pre className="wf-step-inspector__pre wf-step-inspector__pre--error">
              {run?.error ??
                'Step failed but no error message was captured. Re-run the workflow to surface details.'}
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

/**
 * Renders the trigger ("step 0") — cron schedule or manual entrypoints,
 * plus a tiny last-fire summary if a run exists. The trigger isn't a
 * pipeline node, so it gets its own panel instead of being shoehorned
 * into StepInspector with NaN indices.
 */
function TriggerInspector({
  workflow,
  run,
}: {
  workflow: WorkflowDef;
  run: WorkflowRun | null;
}) {
  const t = workflow.trigger;
  const palette = t.kind === 'manual' && t.palette ? `/${t.palette}` : null;
  return (
    <div className="wf-step-inspector">
      <header className="wf-step-inspector__head">
        <span className="wf-step-inspector__index">trigger</span>
        <span className="wf-step-inspector__type">
          {t.kind === 'cron' ? `cron · ${t.every}` : 'manual'}
        </span>
      </header>
      <div className="wf-step-inspector__body">
        <section className="wf-step-inspector__section">
          <h4 className="wf-step-inspector__section-title">Configuration</h4>
          <div className="wf-detail">
            <div className="wf-field">
              <span className="wf-field__label">Kind</span>
              <span className="wf-field__value">{t.kind}</span>
            </div>
            {t.kind === 'cron' && (
              <div className="wf-field">
                <span className="wf-field__label">Schedule</span>
                <span className="wf-field__value wf-field__value--mono">
                  <code>{t.every}</code>
                </span>
              </div>
            )}
            {t.kind === 'manual' && (
              <div className="wf-field">
                <span className="wf-field__label">Entrypoints</span>
                <span className="wf-field__value">
                  {palette ? (
                    <>
                      palette <code>{palette}</code> · MCP · UI
                    </>
                  ) : (
                    'palette · MCP · UI'
                  )}
                </span>
              </div>
            )}
            <div className="wf-detail__hint">
              Triggers are configured in JSON — edit the <code>trigger</code>{' '}
              block above.
            </div>
          </div>
        </section>
        <section className="wf-step-inspector__section">
          <h4 className="wf-step-inspector__section-title">Last fire</h4>
          {!run ? (
            <div className="wf-dock__empty">
              Not fired yet. Hit Run now or wait for the trigger to fire.
            </div>
          ) : (
            <div className="wf-detail">
              <div className="wf-field">
                <span className="wf-field__label">When</span>
                <span className="wf-field__value">
                  {new Date(run.startedAt).toLocaleString()}
                </span>
              </div>
              <div className="wf-field">
                <span className="wf-field__label">Source</span>
                <span className="wf-field__value">
                  <code>{run.trigger}</code>
                </span>
              </div>
              <div className="wf-field">
                <span className="wf-field__label">Outcome</span>
                <span
                  className={`wf-step-inspector__status wf-step-inspector__status--${run.status}`}
                >
                  {run.status}
                </span>
              </div>
            </div>
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
