import { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkflowDef, WorkflowNodeDef, WorkflowRun } from '../../shared/types';
import { toast } from './Toaster';
import { NodeDetail } from './workflows/NodeDetail';
import { NODE_TEMPLATES } from './workflows/nodePalette';
import { WorkflowChat } from './workflows/WorkflowChat';
import {
  WorkflowPipeline,
  type WorkflowSelection,
} from './workflows/WorkflowPipeline';
import { WorkflowsList } from './workflows/WorkflowsList';

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
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [inspectedRunIdx, setInspectedRunIdx] = useState<number>(0);
  /** Kebab overflow menu for Enable / Duplicate / Delete. */
  const [overflowOpen, setOverflowOpen] = useState<boolean>(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const [dockTab, setDockTab] = useState<DockTab>('json');
  const [selectedNode, setSelectedNode] = useState<WorkflowSelection | null>(
    null,
  );
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const paletteRef = useRef<HTMLDivElement | null>(null);
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

  // Same outside-click pattern for the toolbar kebab overflow menu.
  useEffect(() => {
    if (!overflowOpen) return undefined;
    const onClick = (e: MouseEvent): void => {
      if (!overflowRef.current) return;
      if (overflowRef.current.contains(e.target as Node)) return;
      setOverflowOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [overflowOpen]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const { workflows: list, errors: errs } = await window.jarvis.listWorkflows();
      if (cancelled) return;
      setWorkflows(list);
      setErrors(errs);
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
      setRuns([]);
      setInspectedRunIdx(0);
      return;
    }
    let cancelled = false;
    void window.jarvis.listWorkflowRuns(selectedId).then((list) => {
      if (cancelled) return;
      setRuns(list);
      setInspectedRunIdx(0);
    });
    const off = window.jarvis.onWorkflowRunChanged((run) => {
      if (run.workflowId !== selectedId) return;
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id);
        if (idx === -1) return [run, ...prev];
        const next = prev.slice();
        next[idx] = run;
        return next;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [selectedId]);

  const recentRun = runs[inspectedRunIdx] ?? null;

  // Recent runs across ALL workflows — fed into the selector for the
  // per-row health sparkline. Refreshes on every workflowRunChanged
  // (one shared subscription so a fire on a non-selected workflow
  // still updates that row's sparkline).
  const [allRuns, setAllRuns] = useState<WorkflowRun[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.jarvis.listWorkflowRuns().then((list) => {
      if (!cancelled) setAllRuns(list);
    });
    const off = window.jarvis.onWorkflowRunChanged((run) => {
      setAllRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id);
        if (idx === -1) return [run, ...prev].slice(0, 400);
        const next = prev.slice();
        next[idx] = run;
        return next;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const recentByWorkflow = useMemo(() => {
    const map = new Map<string, WorkflowRun[]>();
    for (const r of allRuns) {
      const arr = map.get(r.workflowId) ?? [];
      if (arr.length < 10) arr.push(r);
      map.set(r.workflowId, arr);
    }
    return map;
  }, [allRuns]);

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
    if (result.warnings && result.warnings.length > 0) {
      toast({
        kind: 'info',
        message: `Saved · ${parsed.name} — ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}: ${result.warnings[0]}${result.warnings.length > 1 ? ` (+${result.warnings.length - 1} more)` : ''}`,
      });
    } else {
      toast({ message: `Saved · ${parsed.name}` });
    }
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

  /**
   * Flip the selected workflow's `enabled` flag. Used by the kebab
   * menu in the detail view's toolbar. Surfaces failures so the
   * user sees what's going on if the save is rejected (instead of
   * the previous silent fail).
   */
  const toggleEnabled = async (): Promise<void> => {
    if (!selected) return;
    await toggleWorkflowEnabled(selected, !selected.enabled);
  };

  /** Shared helper — used by both the detail-view kebab and the
   *  index page row toggle. Save + surface errors via toast. */
  const toggleWorkflowEnabled = async (
    def: WorkflowDef,
    next: boolean,
  ): Promise<void> => {
    const result = await window.jarvis.saveWorkflow({ ...def, enabled: next });
    if (!result.ok) {
      toast({
        kind: 'error',
        message: `Could not ${next ? 'enable' : 'disable'} · ${result.message ?? 'save failed'}`,
      });
      return;
    }
    toast({
      message: `${def.name} · ${next ? 'enabled' : 'disabled'}`,
    });
  };

  /**
   * Fork the selected workflow into a user-owned copy. Useful when
   * the user wants to customize a built-in (Slack / Linear / etc.)
   * without the seed migration ever overwriting their changes —
   * the migration only touches the original ids, not derived ones.
   *
   * Picks a fresh id by suffixing -copy / -copy-2 / ... until a slot
   * is free, then saves + switches focus.
   */
  const duplicate = async (): Promise<void> => {
    if (!selected) return;
    const baseId = `${selected.id}-copy`;
    const existingIds = new Set(workflows.map((w) => w.id));
    let id = baseId;
    let suffix = 1;
    while (existingIds.has(id)) {
      suffix += 1;
      id = `${baseId}-${suffix}`;
    }
    // Disabled by default — the user usually wants to tweak before
    // it starts firing. They can flip Enable when ready.
    const copy: WorkflowDef = {
      ...selected,
      id,
      name: `${selected.name} (copy)`,
      description: selected.description
        ? `Copy of ${selected.id}. ${selected.description}`
        : `Copy of ${selected.id}.`,
      enabled: false,
    };
    const r = await window.jarvis.saveWorkflow(copy);
    if (!r.ok) {
      toast({ kind: 'error', message: r.message ?? 'Duplicate failed' });
      return;
    }
    toast({ message: `Duplicated · ${copy.name}` });
    setSelectedId(copy.id);
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
    setDockTab('json');
    toast({
      message: `+ ${stub.type} step appended — edit the params in the JSON dock`,
    });
  };

  return (
    <section className="wf-page">
      <header className="wf-toolbar">
        {selected ? (
          <>
            <button
              type="button"
              className="wf-btn wf-btn--ghost"
              onClick={() => setSelectedId(null)}
              title="Back to all workflows"
            >
              ← All workflows
            </button>
            <div className="wf-toolbar__divider" aria-hidden />
            <span className="wf-toolbar__title">{selected.name}</span>
            <div className="wf-toolbar__divider" aria-hidden />
            <div className="wf-toolbar__group">
              <span
                className={`wf-toolbar__trigger wf-toolbar__trigger--${selected.trigger.kind}`}
                title={
                  selected.enabled
                    ? `Trigger: ${triggerLabel(selected.trigger)}`
                    : 'Workflow is disabled'
                }
              >
                <span
                  className={`wf-toolbar__trigger-dot${selected.enabled ? ' wf-toolbar__trigger-dot--on' : ''}`}
                  aria-hidden
                />
                {triggerLabel(selected.trigger)}
              </span>
              <button
                type="button"
                className="wf-btn wf-btn--primary"
                onClick={() => void runNow()}
                title="Trigger this workflow immediately"
              >
                ▶ Run now
              </button>
              <div className="wf-overflow" ref={overflowRef}>
                <button
                  type="button"
                  className="wf-btn wf-btn--icon"
                  onClick={() => setOverflowOpen((v) => !v)}
                  aria-expanded={overflowOpen}
                  aria-label="More actions"
                  title="More actions"
                >
                  ⋯
                </button>
                {overflowOpen && (
                  <div className="wf-overflow__menu" role="menu">
                    <button
                      type="button"
                      className="wf-overflow__item"
                      onClick={() => {
                        setOverflowOpen(false);
                        void toggleEnabled();
                      }}
                    >
                      {selected.enabled ? 'Disable trigger' : 'Enable trigger'}
                    </button>
                    <button
                      type="button"
                      className="wf-overflow__item"
                      onClick={() => {
                        setOverflowOpen(false);
                        void duplicate();
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="wf-overflow__item wf-overflow__item--danger"
                      onClick={() => {
                        setOverflowOpen(false);
                        void remove();
                      }}
                    >
                      Delete workflow
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <span className="wf-toolbar__title">Workflows</span>
        )}
        <div className="wf-toolbar__spacer" />
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

      <div className="wf-body">
        <div className="wf-graph">
          {!selected ? (
            <WorkflowsList
              workflows={workflows}
              recentByWorkflow={recentByWorkflow}
              onSelect={setSelectedId}
              onToggle={(def, next) => void toggleWorkflowEnabled(def, next)}
            />
          ) : (
            <>
              <WorkflowPipeline
                workflow={selected}
                run={recentRun}
                selected={selectedNode}
                onSelect={(sel) => {
                  setSelectedNode(sel);
                  setDockTab('step');
                }}
              />
              {/* Floating add-node palette pinned to the canvas. The
                  whole popover (button + dropdown) is one element so
                  the outside-click handler defined in the existing
                  paletteRef effect still works without changes. */}
              <div className="wf-palette wf-palette--floating" ref={paletteRef}>
                <button
                  type="button"
                  className="wf-palette__fab"
                  onClick={() => setPaletteOpen((v) => !v)}
                  aria-expanded={paletteOpen}
                  title="Append a new step"
                >
                  <span className="wf-palette__fab-glyph">+</span>
                  Add node
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
            </>
          )}
        </div>

        {selected && (
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
                  <div className="wf-run-pane">
                    {runs.length > 1 && (
                      <RunHistoryList
                        runs={runs}
                        selectedIdx={inspectedRunIdx}
                        onSelect={(i) => {
                          setInspectedRunIdx(i);
                          setSelectedNode(null);
                        }}
                      />
                    )}
                    <RunDetail
                      run={recentRun}
                      selectedIndex={
                        selectedNode?.kind === 'step'
                          ? selectedNode.index
                          : null
                      }
                      onSelectStep={(i) => {
                        setSelectedNode({ kind: 'step', index: i });
                        setDockTab('step');
                      }}
                    />
                  </div>
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
                <WorkflowChat selectedId={selected?.id ?? null} />
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
  if (t.kind === 'autopilot') {
    return t.when === 'cron'
      ? `⚡ autopilot · cron ${t.every ?? '?'}`
      : `⚡ autopilot · on ${(t.sources ?? []).join(', ') || 'inbox'}`;
  }
  return `manual${t.palette ? ' · ' + t.palette : ''}`;
}

/**
 * Compact history strip — one row per past run, ordered newest first.
 * Click a row → the dock's Run-pane shows that run's step breakdown.
 * Persisted runs come from SQLite (workflow-runner.list() merges live
 * + DB) so this survives app restarts.
 */
function RunHistoryList({
  runs,
  selectedIdx,
  onSelect,
}: {
  runs: WorkflowRun[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}) {
  return (
    <ol className="wf-run-history">
      {runs.map((r, i) => {
        const dur =
          r.endedAt != null ? `${r.endedAt - r.startedAt}ms` : '…';
        return (
          <li
            key={r.id}
            className={`wf-run-history__row wf-run-history__row--${r.status}${
              i === selectedIdx ? ' wf-run-history__row--selected' : ''
            }`}
            onClick={() => onSelect(i)}
          >
            <span
              className={`wf-run-history__status wf-run-history__status--${r.status}`}
            >
              {r.status}
            </span>
            <span className="wf-run-history__when">
              {formatRunWhen(r.startedAt)}
            </span>
            <span className="wf-run-history__dur">{dur}</span>
            <span className="wf-run-history__trigger">· {r.trigger}</span>
          </li>
        );
      })}
    </ol>
  );
}

function formatRunWhen(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleString();
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
