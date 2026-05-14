import { useEffect, useState } from 'react';

import type { AppStatus, ModuleSummary, Reminder, TaskSummary } from '../../shared/types';
import { getModulePage } from '../modules/registry';
import { Integrations } from './integrations/Integrations';
import { Logo } from './Logo';
import { MeetingOverlay } from './MeetingOverlay';
import { PreferencesDialog } from './PreferencesDialog';
import { NewProjectDialog } from './projects/NewProjectDialog';
import { Projects } from './projects/Projects';
import { ScopePicker } from './projects/ScopePicker';
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

export function Shell({ status }: Props) {
  const [tab, setTab] = useState<Tab>('observatory');
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);
  const [openModule, setOpenModule] = useState<ModuleSummary | null>(null);
  const [moduleList, setModuleList] = useState<ModuleSummary[]>([]);
  /**
   * Active project scope. When set, free-text palette dispatches auto-
   * prefix with "<alias>:", notes/meetings default to that project,
   * and skills get the project memory loaded. Persisted to localStorage
   * so it survives a restart.
   */
  const [activeProject, setActiveProject] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem('jarvis.activeProject') || null;
    } catch {
      return null;
    }
  });
  const [projectList, setProjectList] = useState<{ name: string; aliases: string[] }[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectInitial, setNewProjectInitial] = useState<string>('');
  const [prefsOpen, setPrefsOpen] = useState(false);

  useEffect(() => {
    const apply = (list: { name: string; aliases: string[] }[]) =>
      setProjectList(list.map((p) => ({ name: p.name, aliases: p.aliases })));
    void window.jarvis.listProjects().then(apply);
    return window.jarvis.onProjectsChanged(apply);
  }, []);

  // Module that wants to open the dialog (e.g. the /new-project palette
  // intent broadcasts shell:open-new-project on this BrowserWindow's IPC).
  useEffect(() => {
    const onOpen = () => setNewProjectOpen(true);
    window.addEventListener('jarvis:open-new-project', onOpen);
    return () => window.removeEventListener('jarvis:open-new-project', onOpen);
  }, []);

  useEffect(() => {
    try {
      if (activeProject) {
        window.localStorage.setItem('jarvis.activeProject', activeProject);
      } else {
        window.localStorage.removeItem('jarvis.activeProject');
      }
    } catch {
      // ignore
    }
    // Push to main so it lands in every task's user-context block.
    void window.jarvis.setActiveProject(activeProject);
    // Broadcast to the palette window (different BrowserWindow) so it
    // picks up the scope.
    window.dispatchEvent(
      new CustomEvent('jarvis:active-project-changed', {
        detail: { project: activeProject },
      }),
    );
  }, [activeProject]);
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
      action?: 'open-new-project';
      initial?: string;
    }) => {
      if (payload.tab) setTab(payload.tab);
      if (payload.tab) setOpenModuleId(payload.moduleId ?? null);
      else if (payload.moduleId !== undefined) setOpenModuleId(payload.moduleId);
      if (payload.action === 'open-new-project') {
        setNewProjectInitial(payload.initial ?? '');
        setNewProjectOpen(true);
      }
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
          <Logo />
          <span className="shell__brand-text">JARVIS</span>
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
          <ScopePicker
            projects={projectList}
            active={activeProject}
            onChange={setActiveProject}
            onCreate={() => setNewProjectOpen(true)}
          />
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
          <button
            className="shell__prefs-btn"
            onClick={() => setPrefsOpen(true)}
            title="Edit your preferences — applied to every task"
          >
            prefs
          </button>
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

      {moduleList.some((m) => m.hasPage && m.enabled) && (
        <div className="shell__subnav">
          <span className="shell__subnav-label">Pages</span>
          <div className="shell__subnav-tabs">
            {moduleList
              .filter((m) => m.hasPage && m.enabled)
              .map((m) => (
                <button
                  key={m.id}
                  className={`shell__subnav-tab${
                    m.id === openModuleId ? ' shell__subnav-tab--active' : ''
                  }`}
                  onClick={() => {
                    if (m.id === openModuleId) {
                      // Already open — toggle back to the modules grid.
                      setOpenModuleId(null);
                      setTab('modules');
                    } else {
                      setOpenModuleId(m.id);
                    }
                  }}
                  title={m.description}
                >
                  {m.name}
                </button>
              ))}
          </div>
          {openModuleId && (
            <button
              onClick={() => {
                setOpenModuleId(null);
                setTab('modules');
              }}
              className="shell__subnav-back"
              title="Back to all modules"
            >
              ← All
            </button>
          )}
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
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(def) => setActiveProject(def.name)}
        initialName={newProjectInitial}
      />
      <PreferencesDialog open={prefsOpen} onClose={() => setPrefsOpen(false)} />
      <Toaster />
    </div>
  );
}
