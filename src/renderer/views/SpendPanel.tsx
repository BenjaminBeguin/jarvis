import { useEffect, useMemo, useState } from 'react';

import type { CostBreakdown, CostPrefs } from '../../shared/types';

/**
 * Spend dashboard. Aggregates `tasks.cost_usd` over a selectable
 * window (1 / 7 / 30 / 90 days) and breaks it down four ways:
 *
 *   - by day — chronological sparkline so you can see the daily
 *     spend trend. A routine that quietly doubled its run cost
 *     shows up as a step.
 *   - by skill — sorted desc. The expensive skills are the
 *     candidates for session pooling (the "C" plan).
 *   - by origin — palette / routine / reminder / voice / api.
 *     Tells you whether the money goes to user-initiated work
 *     or unattended automation.
 *   - by routine — only rows with `routine_id`, so you can spot
 *     a specific cron-fired routine eating budget vs. another.
 *
 * No moduleId yet — for now skillId is the proxy for module
 * attribution (send-skill → send-module, etc.). Adding a
 * first-class moduleId would require threading it through the
 * launch flow + a DB migration; deferred until we hit a case
 * where skillId doesn't disambiguate.
 *
 * External-origin tasks (claude-code-watch mirrors) are excluded
 * upstream — those aren't Jarvis spend.
 */

type Window = 1 | 7 | 30 | 90;

const WINDOW_LABELS: Record<Window, string> = {
  1: 'Today',
  7: 'Last 7 days',
  30: 'Last 30 days',
  90: 'Last 90 days',
};

export function SpendPanel() {
  const [windowDays, setWindowDays] = useState<Window>(7);
  const [data, setData] = useState<CostBreakdown | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.jarvis.costBreakdown(windowDays).then((d) => {
      if (cancelled) return;
      setData(d);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  // Max day value for the bar-height normalization. Computed on
  // the byDay buckets so a $5 day vs a $0.10 day visually scale.
  const maxDay = useMemo(() => {
    if (!data) return 0;
    return data.byDay.reduce((m, d) => Math.max(m, d.totalUsd), 0);
  }, [data]);

  return (
    <div className="settings__section spend-panel">
      <div className="spend-panel__head">
        <h3>SPEND</h3>
        <div className="spend-panel__window">
          {(Object.entries(WINDOW_LABELS) as Array<[string, string]>).map(
            ([d, label]) => {
              const n = Number(d) as Window;
              return (
                <button
                  key={d}
                  className={`spend-panel__window-btn${
                    windowDays === n ? ' spend-panel__window-btn--active' : ''
                  }`}
                  onClick={() => setWindowDays(n)}
                >
                  {label}
                </button>
              );
            },
          )}
        </div>
      </div>

      <p className="settings__hint">
        Per-task cost is recorded by the SDK at turn completion. Cold
        starts (system prompt + skill body + tool inventory) dominate
        short turns — the skills near the top of the breakdown are
        candidates for session pooling. External Claude Code sessions
        are excluded; that's their spend, not ours.
      </p>

      {loading && (
        <div className="spend-panel__loading">Loading breakdown…</div>
      )}

      {data && !loading && (
        <>
          <section className="spend-panel__total">
            <div className="spend-panel__total-value">
              ${data.total.toFixed(2)}
            </div>
            <div className="spend-panel__total-label">
              {WINDOW_LABELS[windowDays].toLowerCase()} ·{' '}
              {data.bySkill.reduce((s, r) => s + r.taskCount, 0)} tasks
            </div>
          </section>

          {(data.pool.pooledTaskCount > 0 || data.pool.freshTaskCount > 0) && (
            <section className="spend-panel__pool">
              <h4 className="settings__subhead">POOLING</h4>
              <div className="spend-panel__pool-row">
                <span>
                  <strong>{data.pool.pooledTaskCount}</strong> resumed ·{' '}
                  <strong>{data.pool.freshTaskCount}</strong> fresh
                </span>
                <span className="spend-panel__pool-savings">
                  {(() => {
                    const total =
                      data.pool.pooledTaskCount + data.pool.freshTaskCount;
                    if (total === 0) return null;
                    const ratio = (data.pool.pooledTaskCount / total) * 100;
                    return `${ratio.toFixed(0)}% pooled`;
                  })()}
                </span>
              </div>
              <p className="settings__hint">
                Pooled palette / voice tasks resumed an active SDK
                session instead of paying the cold start (system
                prompt + skill body + tool inventory). Each
                resumption saves roughly $0.005-0.02 depending on
                skill body size + MCP count. Routines and reminders
                don't pool — those fires intentionally stay isolated.
              </p>
            </section>
          )}

          <section className="spend-panel__chart">
            <h4 className="settings__subhead">DAILY</h4>
            <div
              className="spend-panel__bars"
              aria-label={`Daily spend chart for the last ${windowDays} days`}
            >
              {data.byDay.map((d) => {
                const pct = maxDay > 0 ? d.totalUsd / maxDay : 0;
                return (
                  <div
                    key={d.date}
                    className="spend-panel__bar-col"
                    title={`${d.date} · $${d.totalUsd.toFixed(4)} · ${d.taskCount} task${d.taskCount === 1 ? '' : 's'}`}
                  >
                    <div
                      className="spend-panel__bar"
                      style={{ height: `${Math.max(2, pct * 100)}%` }}
                      data-empty={d.totalUsd === 0 ? 'true' : undefined}
                    />
                  </div>
                );
              })}
            </div>
            <div className="spend-panel__bars-axis">
              <span>{data.byDay[0]?.date.slice(5) ?? ''}</span>
              <span>{data.byDay[data.byDay.length - 1]?.date.slice(5) ?? ''}</span>
            </div>
          </section>

          <section>
            <h4 className="settings__subhead">BY SKILL</h4>
            <SpendTable
              rows={data.bySkill.map((r) => ({
                key: r.skillId ?? '(no skill · palette free-text)',
                label: r.skillId ?? '(no skill · palette free-text)',
                totalUsd: r.totalUsd,
                taskCount: r.taskCount,
              }))}
              total={data.total}
              emptyHint="No spend in this window."
            />
          </section>

          <section>
            <h4 className="settings__subhead">BY ORIGIN</h4>
            <SpendTable
              rows={data.byOrigin.map((r) => ({
                key: r.origin,
                label: r.origin,
                totalUsd: r.totalUsd,
                taskCount: r.taskCount,
              }))}
              total={data.total}
              emptyHint="No spend in this window."
            />
          </section>

          {data.byRoutine.length > 0 && (
            <section>
              <h4 className="settings__subhead">BY ROUTINE</h4>
              <SpendTable
                rows={data.byRoutine.map((r) => ({
                  key: r.routineId,
                  label: r.routineId,
                  totalUsd: r.totalUsd,
                  taskCount: r.taskCount,
                }))}
                total={data.total}
                emptyHint="No routine spend in this window."
              />
            </section>
          )}

          {data.byProject.length > 0 && (
            <section>
              <h4 className="settings__subhead">BY PROJECT</h4>
              <SpendTable
                rows={data.byProject.map((r) => ({
                  key: r.projectName,
                  label: r.projectName,
                  totalUsd: r.totalUsd,
                  taskCount: r.taskCount,
                }))}
                total={data.total}
                emptyHint="No project-scoped spend in this window."
              />
            </section>
          )}

          <GuardrailsEditor />
        </>
      )}
    </div>
  );
}

/**
 * Inline editor for the two cost guardrails — per-task warning + daily
 * total budget. Saving to the new costPrefsWrite IPC; the wireRunnerEvents
 * loop in main re-reads on every status change so changes take effect
 * without a restart. 0 in either field disables that guardrail.
 */
function GuardrailsEditor() {
  const [prefs, setPrefs] = useState<CostPrefs | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.jarvis.costPrefsRead().then(setPrefs);
  }, []);

  const update = async (patch: Partial<CostPrefs>) => {
    if (!prefs) return;
    const next: CostPrefs = { ...prefs, ...patch };
    setPrefs(next);
    setSaving(true);
    try {
      await window.jarvis.costPrefsWrite(next);
    } finally {
      setSaving(false);
    }
  };

  if (!prefs) return null;

  return (
    <section className="spend-panel__guardrails">
      <h4 className="settings__subhead">GUARDRAILS</h4>
      <p className="settings__hint">
        macOS notifications when a task or your daily total crosses one
        of these. 0 in either field disables that warning. Changes
        apply on the next task status event — no restart needed.
      </p>
      <div className="spend-panel__guardrails-row">
        <label>
          <span>Per-task warn at</span>
          <span className="spend-panel__guardrails-input">
            $
            <input
              type="number"
              min={0}
              step="0.01"
              value={prefs.perTaskUsd}
              disabled={saving}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v >= 0) {
                  void update({ perTaskUsd: v });
                }
              }}
            />
          </span>
        </label>
        <label>
          <span>Daily budget warn at</span>
          <span className="spend-panel__guardrails-input">
            $
            <input
              type="number"
              min={0}
              step="0.5"
              value={prefs.dailyUsd}
              disabled={saving}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v >= 0) {
                  void update({ dailyUsd: v });
                }
              }}
            />
          </span>
        </label>
      </div>
      <label className="spend-panel__guardrails-checkbox">
        <input
          type="checkbox"
          checked={prefs.autoPauseOnDaily}
          disabled={saving || prefs.dailyUsd <= 0}
          onChange={(e) => void update({ autoPauseOnDaily: e.target.checked })}
        />
        <span>
          Also <strong>auto-pause Jarvis</strong> when the daily budget is crossed
          <span className="spend-panel__guardrails-checkbox-hint">
            {' '}— routines + scheduled actions skip until you resume. User-initiated palette / voice still runs.
          </span>
        </span>
      </label>
    </section>
  );
}

function SpendTable({
  rows,
  total,
  emptyHint,
}: {
  rows: Array<{
    key: string;
    label: string;
    totalUsd: number;
    taskCount: number;
  }>;
  total: number;
  emptyHint: string;
}) {
  if (rows.length === 0) {
    return <div className="spend-panel__empty">{emptyHint}</div>;
  }
  return (
    <ul className="spend-panel__rows">
      {rows.map((r) => {
        const pct = total > 0 ? (r.totalUsd / total) * 100 : 0;
        return (
          <li key={r.key} className="spend-panel__row">
            <div className="spend-panel__row-bar">
              <div
                className="spend-panel__row-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="spend-panel__row-text">
              <span className="spend-panel__row-label">{r.label}</span>
              <span className="spend-panel__row-amount">
                ${r.totalUsd.toFixed(r.totalUsd < 0.01 ? 4 : 2)}
              </span>
              <span className="spend-panel__row-count">
                {r.taskCount} task{r.taskCount === 1 ? '' : 's'}
              </span>
              <span className="spend-panel__row-pct">{pct.toFixed(0)}%</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
