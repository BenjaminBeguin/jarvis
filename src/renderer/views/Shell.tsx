import { useEffect, useRef, useState } from 'react';

import type { AppStatus, ModuleSummary, ProjectDef, Reminder, TaskSummary } from '../../shared/types';
import { getModulePage } from '../modules/registry';
import { Briefings } from './Briefings';
import { Inbox } from './Inbox';
import { Logo } from './Logo';
import { MeetingOverlay } from './MeetingOverlay';
import { MeetingPrompt } from './MeetingPrompt';
import { NewProjectDialog } from './projects/NewProjectDialog';
import { Projects } from './projects/Projects';
import { ScopePicker } from './projects/ScopePicker';
import { Settings } from './Settings';
import { toast } from './Toaster';
import { Toaster } from './Toaster';
import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab = 'observatory' | 'inbox' | 'briefings' | 'projects' | 'routines' | 'settings';

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
  const [projectList, setProjectList] = useState<ProjectDef[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectInitial, setNewProjectInitial] = useState<string>('');
  // Skip the toast on the initial render — the activeProject useEffect
  // fires once on mount with the value loaded from localStorage and we
  // don't want a "Scope set to …" toast every time the window opens.
  const scopeToastSeededRef = useRef(false);

  useEffect(() => {
    const apply = (list: ProjectDef[]) => setProjectList(list);
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
    // Visible feedback. Without this, picking a scope feels like a
    // no-op because most of the cascade (cwd of next task, project
    // memory load) is invisible until you actually launch something.
    if (scopeToastSeededRef.current) {
      if (activeProject) {
        const def = projectList.find((p) => p.name === activeProject);
        if (def?.path) {
          toast({ message: `Scope: ${activeProject} · cwd ${def.path}` });
        } else {
          toast({
            kind: 'info',
            message: `Scope: ${activeProject} · no path set in projects.json — tasks will still run in ~`,
          });
        }
      } else {
        toast({ message: 'Scope cleared' });
      }
    } else {
      scopeToastSeededRef.current = true;
    }
  }, [activeProject, projectList]);
  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [runningCount, setRunningCount] = useState(0);
  const [awaitingCount, setAwaitingCount] = useState(0);
  const [scheduledCount, setScheduledCount] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  // Cmd+1..6 tab shortcuts. Standard pattern across editors; saves a
  // mouse round-trip when the user wants to flip between Observatory
  // and Inbox dozens of times a day. Skipped when focus is in a text
  // input so the user can still type "⌘1" in markdown.
  useEffect(() => {
    const tabsOrder: Tab[] = [
      'observatory',
      'inbox',
      'briefings',
      'projects',
      'routines',
      'settings',
    ];
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const inField =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;
      if (inField) return;
      const idx = parseInt(e.key, 10);
      if (Number.isFinite(idx) && idx >= 1 && idx <= tabsOrder.length) {
        e.preventDefault();
        setTab(tabsOrder[idx - 1]!);
        setOpenModuleId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Verbal nav: the shell-nav module fires shell:navigate when the user
  // says "open settings", "show observatory", etc. Switch the tab + module
  // page state to match. We also listen for a renderer-side window event
  // ('jarvis:navigate') so views like Constellation can request nav
  // without an IPC round-trip.
  useEffect(() => {
    const applyNav = (payload: {
      tab?: 'observatory' | 'inbox' | 'briefings' | 'projects' | 'routines' | 'settings';
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
            title="⌘1"
          >
            Observatory
          </button>
          <button
            className={`shell__tab${tab === 'inbox' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('inbox');
              setOpenModuleId(null);
            }}
            title="⌘2"
          >
            Inbox
          </button>
          <button
            className={`shell__tab${tab === 'briefings' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('briefings');
              setOpenModuleId(null);
            }}
            title="⌘3"
          >
            Briefings
          </button>
          <button
            className={`shell__tab${tab === 'projects' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('projects');
              setOpenModuleId(null);
            }}
            title="⌘4"
          >
            Projects
          </button>
          <button
            className={`shell__tab${tab === 'routines' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('routines');
              setOpenModuleId(null);
            }}
            title="⌘5"
          >
            Routines
          </button>
          <button
            className={`shell__tab shell__tab--settings${tab === 'settings' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('settings');
              setOpenModuleId(null);
            }}
            title="⌘6 · Preferences · Modules · Integrations · API"
          >
            ⚙ Settings
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
            className="shell__auth-badge"
            onClick={() => {
              setTab('settings');
              setOpenModuleId(null);
            }}
            title="Auth mode — click for Settings"
          >
            {badge}
          </button>
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
                      // Already open — toggle back to the modules grid (in Settings).
                      setOpenModuleId(null);
                      setTab('settings');
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
                setTab('settings');
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
        ) : tab === 'inbox' ? (
          <Inbox />
        ) : tab === 'briefings' ? (
          <Briefings />
        ) : tab === 'projects' ? (
          <Projects />
        ) : tab === 'routines' ? (
          <Routines />
        ) : (
          <Settings
            status={status}
            onOpenModulePage={(id) => setOpenModuleId(id)}
          />
        )}
      </div>
      <MeetingOverlay />
      <MeetingPrompt />
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(def) => setActiveProject(def.name)}
        initialName={newProjectInitial}
      />
      <Toaster />
    </div>
  );
}
