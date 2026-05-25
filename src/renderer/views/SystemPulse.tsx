import { useEffect, useState } from 'react';

import type {
  ConnectorSummary,
  RoutineDef,
  WorkflowDef,
} from '../../shared/types';

/**
 * Compact status strip at the top of the Dashboard. Replaces the
 * dedicated Setup page — the user wanted "how many routines, how
 * many workflows, and what's still missing" at a glance, not a
 * separate configuration surface.
 *
 * One line of chips. Click a chip to jump to the relevant tab.
 * Each chip shows a count + optional accent dot when something
 * needs attention (no integrations / no autopilots enabled).
 */

interface Counts {
  routines: number;
  workflowsEnabled: number;
  workflowsTotal: number;
  draftsPending: number;
  integrationsConnected: number;
  autopilotsEnabled: number;
  autopilotsTotal: number;
}

function emptyCounts(): Counts {
  return {
    routines: 0,
    workflowsEnabled: 0,
    workflowsTotal: 0,
    draftsPending: 0,
    integrationsConnected: 0,
    autopilotsEnabled: 0,
    autopilotsTotal: 0,
  };
}

function navigate(tab: string): void {
  window.dispatchEvent(
    new CustomEvent('jarvis:navigate', { detail: { tab } }),
  );
}

function navigateSettings(section: string): void {
  window.dispatchEvent(
    new CustomEvent('jarvis:navigate', {
      detail: { tab: 'settings', settingsSection: section },
    }),
  );
}

export function SystemPulse() {
  const [counts, setCounts] = useState<Counts>(() => emptyCounts());

  useEffect(() => {
    const refresh = async () => {
      try {
        const [routines, wfRes, drafts, integrations] = await Promise.all([
          window.jarvis.listRoutines(),
          window.jarvis.listWorkflows(),
          window.jarvis.listDrafts({ status: ['pending', 'failed'] }),
          window.jarvis.listIntegrations(),
        ]);
        const wfList: WorkflowDef[] = wfRes.workflows;
        const autopilots = wfList.filter(
          (w) => w.trigger.kind === 'autopilot',
        );
        setCounts({
          routines: (routines as RoutineDef[]).length,
          workflowsEnabled: wfList.filter((w) => w.enabled).length,
          workflowsTotal: wfList.length,
          draftsPending: drafts.length,
          integrationsConnected: (integrations as ConnectorSummary[])
            .filter(
              (c) => c.accounts.length > 0 && c.id !== 'test-echo',
            ).length,
          autopilotsEnabled: autopilots.filter((w) => w.enabled).length,
          autopilotsTotal: autopilots.length,
        });
      } catch {
        // benign — leave the strip blank if we can't read state
      }
    };
    void refresh();
    const offWf = window.jarvis.onWorkflowsChanged(() => void refresh());
    const offRt = window.jarvis.onRoutinesChanged(() => void refresh());
    const offDr = window.jarvis.onDraftsChanged(() => void refresh());
    const offInt = window.jarvis.onIntegrationsChanged(() => void refresh());
    return () => {
      offWf();
      offRt();
      offDr();
      offInt();
    };
  }, []);

  const needsIntegrations = counts.integrationsConnected === 0;
  const needsAutopilot =
    counts.autopilotsTotal > 0 && counts.autopilotsEnabled === 0;

  return (
    <div className="system-pulse">
      <Chip
        label="Routines"
        value={counts.routines}
        onClick={() => navigate('routines')}
        title="Cron-fired skill tasks"
      />
      <Chip
        label="Workflows"
        value={`${counts.workflowsEnabled} / ${counts.workflowsTotal}`}
        onClick={() => navigate('workflows')}
        title="Pipelines: enabled / total"
      />
      <Chip
        label="Drafts"
        value={counts.draftsPending}
        onClick={() => navigate('drafts')}
        title="AI drafts waiting for your review"
        accent={counts.draftsPending > 0}
      />
      <Chip
        label="Integrations"
        value={counts.integrationsConnected}
        onClick={() => navigateSettings('integrations')}
        title="OAuth-connected accounts (Gmail, Slack, GitHub, …)"
        alert={needsIntegrations}
      />
      <Chip
        label="Autopilot"
        value={`${counts.autopilotsEnabled} on`}
        onClick={() => navigate('workflows')}
        title="Triage workflows enabled in autopilot mode"
        alert={needsAutopilot}
      />
    </div>
  );
}

function Chip({
  label,
  value,
  onClick,
  title,
  accent,
  alert,
}: {
  label: string;
  value: string | number;
  onClick: () => void;
  title: string;
  accent?: boolean;
  alert?: boolean;
}) {
  const cls = `system-pulse__chip${accent ? ' system-pulse__chip--accent' : ''}${
    alert ? ' system-pulse__chip--alert' : ''
  }`;
  return (
    <button type="button" className={cls} onClick={onClick} title={title}>
      <span className="system-pulse__chip-label">{label}</span>
      <span className="system-pulse__chip-value">{value}</span>
      {alert && (
        <span className="system-pulse__chip-dot" aria-hidden>
          •
        </span>
      )}
    </button>
  );
}
