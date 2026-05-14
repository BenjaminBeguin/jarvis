import { useEffect, useState } from 'react';

import type { AppStatus, ModuleSummary, Reminder, TaskSummary } from '../../shared/types';
import { getModulePage } from '../modules/registry';
import { Integrations } from './integrations/Integrations';
import { MeetingOverlay } from './MeetingOverlay';
import { Projects } from './projects/Projects';
import { Toaster } from './Toaster';
import { ModulesPage } from './ModulesPage';
import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab = 'observatory' | 'projects' | 'routines' | 'integrations' | 'modules';

interface Props {
  status: AppStatus;
}

function formatClock(d: Date): string {
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function Reticle() {
  return (
    <svg className="shell__reticle" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="6" />
      <g className="ring--spin">
        <circle cx="7" cy="7" r="3" />
        <line x1="7" y1="0" x2="7" y2="2" />
        <line x1="7" y1="12" x2="7" y2="14" />
        <line x1="0" y1="7" x2="2" y2="7" />
        <line x1="12" y1="7" x2="14" y2="7" />
      </g>
    </svg>
  );
}

export function Shell({ status }: Props) {
  const [tab, setTab] = useState<Tab>('observatory');
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);
  const [openModule, setOpenModule] = useState<ModuleSummary | null>(null);
  const [moduleList, setModuleList] = useState<ModuleSummary[]>([]);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [runningCount, setRunningCount] = useState(0);
  const [awaitingCount, setAwaitingCount] = useState(0);
  const [scheduledCount, setScheduledCount] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  // Verbal nav: the shell-nav module fires shell:navigate when the user
  // says "open settings", "show observatory", etc. Switch the tab + module
  // page state to match. We also listen for a renderer-side window event
  // ('jarvis:navigate') so views like Constellation can request nav
  // without an IPC round-trip.
  useEffect(() => {
    const applyNav = (payload: {
      tab?: 'observatory' | 'projects' | 'routines' | 'integrations' | 'modules';
      moduleId?: string;
    }) => {
      if (payload.tab) setTab(payload.tab);
      setOpenModuleId(payload.moduleId ?? null);
    };
    const offIpc = window.jarvis.onShellNavigate(applyNav);
    const onWindow = (e: Event) => {
      const detail = (e as CustomEvent).detail as Parameters<typeof applyNav>[0];
      if (detail) applyNav(detail);
    };
    window.addEventListener('jarvis:navigate', onWindow);
    return () => {
      offIpc();
      window.removeEventListener('jarvis:navigate', onWindow);
    };
  }, []);

  // Keep the global status pill in sync across tabs. Pulls counts on mount
  // then subscribes for updates.
  useEffect(() => {
    const tally = (tasks: TaskSummary[]) => {
      setRunningCount(
        tasks.filter((t) => t.status === 'running' && t.origin !== 'external')
          .length,
      );
      setAwaitingCount(tasks.filter((t) => t.awaitingInput).length);
    };
    void window.jarvis.listTasks().then(tally);
    void window.jarvis
      .listReminders()
      .then((rs: Reminder[]) =>
        setScheduledCount(rs.filter((r) => r.status === 'pending').length),
      );
    const offStatus = window.jarvis.onTaskStatus(() => {
      void window.jarvis.listTasks().then(tally);
    });
    const offRemoved = window.jarvis.onTaskRemoved(() => {
      void window.jarvis.listTasks().then(tally);
    });
    const offRem = window.jarvis.onRemindersChanged((rs: Reminder[]) =>
      setScheduledCount(rs.filter((r) => r.status === 'pending').length),
    );
    return () => {
      offStatus();
      offRemoved();
      offRem();
    };
  }, []);

  // Always keep the modules list in sync so we can render the sub-nav.
  useEffect(() => {
    void window.jarvis.listModules().then(setModuleList);
    return window.jarvis.onModulesChanged(setModuleList);
  }, []);

  // Keep openModule in sync with the registry — handles "module disabled
  // while its page is open" by closing the page automatically.
  useEffect(() => {
    if (!openModuleId) {
      setOpenModule(null);
      return;
    }
    let cancelled = false;
    const sync = async () => {
      const all = await window.jarvis.listModules();
      if (cancelled) return;
      const m = all.find((x) => x.id === openModuleId);
      if (!m || !m.enabled || !m.hasPage) {
        setOpenModuleId(null);
        setOpenModule(null);
      } else {
        setOpenModule(m);
      }
    };
    void sync();
    const off = window.jarvis.onModulesChanged(() => void sync());
    return () => {
      cancelled = true;
      off();
    };
  }, [openModuleId]);

  const switchAuth = async (mode: 'subscription' | 'api-key') => {
    try {
      await window.jarvis.setAuthMode(mode);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitchOpen(false);
    }
  };

  const badge = status.authMode === 'subscription' ? 'subscription' : 'api key';

  const PageComponent = openModuleId ? getModulePage(openModuleId) : null;

  return (
    <div className="shell">
      <nav className="shell__nav">
        <div className="shell__brand">
          <Reticle />
          JARVIS
        </div>
        <div className="shell__tabs">
          <button
            className={`shell__tab${tab === 'observatory' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('observatory');
              setOpenModuleId(null);
            }}
          >
            Observatory
          </button>
          <button
            className={`shell__tab${tab === 'projects' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('projects');
              setOpenModuleId(null);
            }}
          >
            Projects
          </button>
          <button
            className={`shell__tab${tab === 'routines' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('routines');
              setOpenModuleId(null);
            }}
          >
            Routines
          </button>
          <button
            className={`shell__tab${tab === 'integrations' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('integrations');
              setOpenModuleId(null);
            }}
          >
            Integrations
          </button>
          <button
            className={`shell__tab${tab === 'modules' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('modules');
              setOpenModuleId(null);
            }}
          >
            Modules
          </button>
        </div>
        <div className="shell__right">
          {(runningCount > 0 || awaitingCount > 0 || scheduledCount > 0) && (
            <div className="shell__status-pill" title="Live counts">
              {runningCount > 0 && (
                <span className="shell__status-item shell__status-item--live">
                  ● {runningCount}
                </span>
              )}
              {awaitingCount > 0 && (
                <span className="shell__status-item shell__status-item--awaiting">
                  ◐ {awaitingCount}
                </span>
              )}
              {scheduledCount > 0 && (
                <span className="shell__status-item shell__status-item--scheduled">
                  ⏰ {scheduledCount}
                </span>
              )}
            </div>
          )}
          <div className="shell__clock">
            <span className="dot" />
            {clock}
          </div>
          <div className="shell__auth">
            <button
              className="shell__auth-badge"
              onClick={() => setSwitchOpen((v) => !v)}
              title="Switch auth mode"
            >
              auth: {badge}
            </button>
            {switchOpen && (
              <div className="shell__auth-menu">
                <button
                  disabled={!status.claudeBinaryPath || !status.hasSubscriptionToken}
                  onClick={() => void switchAuth('subscription')}
                >
                  Subscription
                  {!status.claudeBinaryPath && (
                    <span className="shell__auth-hint">claude CLI not found</span>
                  )}
                  {status.claudeBinaryPath && !status.hasSubscriptionToken && (
                    <span className="shell__auth-hint">no setup-token saved</span>
                  )}
                </button>
                <button
                  disabled={!status.hasApiKey}
                  onClick={() => void switchAuth('api-key')}
                >
                  API key
                  {!status.hasApiKey && (
                    <span className="shell__auth-hint">no key on file</span>
                  )}
                </button>
              </div>
            )}
          </div>
          <button
            className="shell__palette-hint"
            onClick={() => void window.jarvis.openPalette()}
            title="Open command palette"
          >
            ⌘⇧J
          </button>
        </div>
      </nav>

      {openModuleId && PageComponent && (
        <div className="shell__subnav">
          <button
            onClick={() => {
              setOpenModuleId(null);
              setTab('modules');
            }}
            className="shell__subnav-back"
            title="Back to all modules"
          >
            ← All modules
          </button>
          <div className="shell__subnav-tabs">
            {moduleList
              .filter((m) => m.hasPage && m.enabled)
              .map((m) => (
                <button
                  key={m.id}
                  className={`shell__subnav-tab${
                    m.id === openModuleId ? ' shell__subnav-tab--active' : ''
                  }`}
                  onClick={() => setOpenModuleId(m.id)}
                  title={m.description}
                >
                  {m.name}
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="shell__body">
        {openModuleId && PageComponent ? (
          <PageComponent />
        ) : tab === 'observatory' ? (
          <Observatory />
        ) : tab === 'projects' ? (
          <Projects />
        ) : tab === 'routines' ? (
          <Routines />
        ) : tab === 'integrations' ? (
          <Integrations />
        ) : (
          <ModulesPage onOpenPage={(id) => setOpenModuleId(id)} />
        )}
      </div>
      <MeetingOverlay />
      <Toaster />
    </div>
  );
}
