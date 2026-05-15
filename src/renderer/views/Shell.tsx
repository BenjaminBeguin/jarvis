import { useEffect, useRef, useState } from 'react';

import type { AppStatus, ModuleSummary, ProjectDef } from '../../shared/types';
import { getModulePage } from '../modules/registry';
import { Inbox } from './Inbox';
import { Logo } from './Logo';
import { MeetingOverlay } from './MeetingOverlay';
import { MeetingPrompt } from './MeetingPrompt';
import { NewProjectDialog } from './projects/NewProjectDialog';
import { Projects } from './projects/Projects';
import { ScopePicker } from './projects/ScopePicker';
import { Activity } from './Activity';
import { Dashboard } from './Dashboard';
import { Settings } from './Settings';
import { Skills } from './Skills';
import { toast } from './Toaster';
import { Toaster } from './Toaster';
import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab =
  | 'dashboard'
  | 'observatory'
  | 'inbox'
  | 'activity'
  | 'projects'
  | 'routines'
  | 'skills'
  | 'settings';

interface Props {
  status: AppStatus;
}

export function Shell({ status }: Props) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);
  /** When set, the Skills view opens with this skill selected and scrolls
   * the list to it. Set by deep-link nav from Briefings / Routines. */
  const [focusedSkillId, setFocusedSkillId] = useState<string | null>(null);
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

  // Cmd+1..5 tab shortcuts + Cmd+[ / Cmd+] for back / forward.
  // Skipped when focus is in a text input so the user can still type
  // "⌘1" in markdown.
  //
  // Projects + Settings aren't in the row: Projects lives inside the
  // scope dropdown ("See all projects"), Settings inside the auth-badge
  // dropdown. They're still reachable programmatically by setTab().
  useEffect(() => {
    const tabsOrder: Tab[] = [
      'dashboard',
      'observatory',
      'inbox',
      'routines',
      'skills',
    ];
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const inField =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;
      if (inField) return;
      // Browser-style back / forward.
      if (e.key === '[') {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        goForward();
        return;
      }
      const idx = parseInt(e.key, 10);
      if (Number.isFinite(idx) && idx >= 1 && idx <= tabsOrder.length) {
        e.preventDefault();
        setTab(tabsOrder[idx - 1]!);
        setOpenModuleId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigation history (browser-style back/forward). Each entry is the
  // (tab, moduleId) pair the user was looking at. New navigations push
  // a new entry; back/forward move the cursor without pushing. A ref
  // skip-flag suppresses the push when we set state from history.
  const [history, setHistory] = useState<Array<{ tab: Tab; moduleId: string | null }>>(
    () => [{ tab: 'dashboard', moduleId: null }],
  );
  const [histIdx, setHistIdx] = useState(0);
  const skipHistoryPushRef = useRef(false);

  useEffect(() => {
    if (skipHistoryPushRef.current) {
      skipHistoryPushRef.current = false;
      return;
    }
    setHistory((h) => {
      const truncated = h.slice(0, histIdx + 1);
      const last = truncated[truncated.length - 1];
      if (last && last.tab === tab && last.moduleId === openModuleId) {
        return h; // no real change; dedupe identical consecutive entries
      }
      const next = [...truncated, { tab, moduleId: openModuleId }];
      setHistIdx(next.length - 1);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, openModuleId]);

  const goBack = () => {
    if (histIdx <= 0) return;
    const target = history[histIdx - 1]!;
    skipHistoryPushRef.current = true;
    setTab(target.tab);
    setOpenModuleId(target.moduleId);
    setHistIdx(histIdx - 1);
  };
  const goForward = () => {
    if (histIdx >= history.length - 1) return;
    const target = history[histIdx + 1]!;
    skipHistoryPushRef.current = true;
    setTab(target.tab);
    setOpenModuleId(target.moduleId);
    setHistIdx(histIdx + 1);
  };
  const canBack = histIdx > 0;
  const canForward = histIdx < history.length - 1;

  // Verbal nav: the shell-nav module fires shell:navigate when the user
  // says "open settings", "show observatory", etc. Switch the tab + module
  // page state to match. We also listen for a renderer-side window event
  // ('jarvis:navigate') so views like Constellation can request nav
  // without an IPC round-trip.
  useEffect(() => {
    const applyNav = (payload: {
      tab?: Tab;
      moduleId?: string;
      action?: 'open-new-project';
      initial?: string;
      skillId?: string;
      /** When opening the merged Notes & Reminders page, which tab to
       *  land on. The CapturePage subscribes to 'jarvis:capture-tab'. */
      captureTab?: 'notes' | 'reminders';
    }) => {
      if (payload.tab) setTab(payload.tab);
      if (payload.tab) setOpenModuleId(payload.moduleId ?? null);
      else if (payload.moduleId !== undefined) setOpenModuleId(payload.moduleId);
      if (payload.action === 'open-new-project') {
        setNewProjectInitial(payload.initial ?? '');
        setNewProjectOpen(true);
      }
      if (payload.tab === 'skills' && payload.skillId) {
        setFocusedSkillId(payload.skillId);
      }
      if (payload.captureTab) {
        window.dispatchEvent(
          new CustomEvent('jarvis:capture-tab', {
            detail: { tab: payload.captureTab },
          }),
        );
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


  // Always keep the modules list in sync so we can render the sub-nav.
  useEffect(() => {
    void window.jarvis.listModules().then(setModuleList);
    return window.jarvis.onModulesChanged(setModuleList);
  }, []);

  // Surface every fired reminder as an in-app toast so the user sees
  // SOMETHING even when macOS notifications are silenced (Focus mode,
  // permission denied, app in foreground bug). The native notification
  // still fires from main; this is the redundant signal.
  //
  // Subscribes to activity events: kind='reminder.fired' rows are the
  // signal. Everything else is ignored — Activity-tab rendering already
  // covers the broader feed.
  useEffect(() => {
    return window.jarvis.onActivityChanged((event) => {
      if (event.kind !== 'reminder.fired') return;
      toast({
        kind: 'info',
        message: event.label.replace(/^Reminder fired · /, '⏰ '),
      });
    });
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
        <div className="shell__nav-history">
          <button
            className="shell__nav-arrow"
            onClick={goBack}
            disabled={!canBack}
            title="Back (⌘[)"
            aria-label="Navigate back"
          >
            ←
          </button>
          <button
            className="shell__nav-arrow"
            onClick={goForward}
            disabled={!canForward}
            title="Forward (⌘])"
            aria-label="Navigate forward"
          >
            →
          </button>
        </div>
        <div className="shell__tabs">
          <button
            className={`shell__tab${tab === 'dashboard' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('dashboard');
              setOpenModuleId(null);
            }}
            title="⌘1 · Your curated home — Inbox, briefings, routines you pinned"
          >
            Dashboard
          </button>
          <button
            className={`shell__tab${tab === 'observatory' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('observatory');
              setOpenModuleId(null);
            }}
            title="⌘2 · Live + recent agent runs (constellation + list)"
          >
            Observatory
          </button>
          <button
            className={`shell__tab${tab === 'inbox' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('inbox');
              setOpenModuleId(null);
            }}
            title="⌘3"
          >
            Inbox
          </button>
          <button
            className={`shell__tab${tab === 'routines' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('routines');
              setOpenModuleId(null);
            }}
            title="⌘4"
          >
            Routines
          </button>
          <button
            className={`shell__tab${tab === 'skills' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('skills');
              setOpenModuleId(null);
              setFocusedSkillId(null);
            }}
            title="⌘5 · Skill prompts (SKILL.md)"
          >
            Skills
          </button>
        </div>
        <div className="shell__right">
          <ScopePicker
            projects={projectList}
            active={activeProject}
            onChange={setActiveProject}
            onCreate={() => setNewProjectOpen(true)}
            onManage={() => {
              setTab('projects');
              setOpenModuleId(null);
            }}
          />
          <button
            className={`shell__icon-btn shell__icon-btn--activity${
              tab === 'activity' && !openModuleId ? ' shell__icon-btn--active' : ''
            }`}
            onClick={() => {
              setTab('activity');
              setOpenModuleId(null);
            }}
            title="Activity · /send history (and later, every other thing you did)"
            aria-label="Activity"
          >
            <svg viewBox="0 0 16 16" aria-hidden width="14" height="14">
              <circle
                cx="8"
                cy="8"
                r="6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M8 4 L8 8 L11 9.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <AuthBadgeMenu
            label={badge}
            settingsActive={tab === 'settings' && !openModuleId}
            onOpenSettings={() => {
              setTab('settings');
              setOpenModuleId(null);
            }}
          />
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
        ) : tab === 'dashboard' ? (
          <Dashboard />
        ) : tab === 'observatory' ? (
          <Observatory />
        ) : tab === 'inbox' ? (
          <Inbox />
        ) : tab === 'activity' ? (
          <Activity />
        ) : tab === 'projects' ? (
          <Projects />
        ) : tab === 'routines' ? (
          <Routines />
        ) : tab === 'skills' ? (
          <Skills
            focusedSkillId={focusedSkillId}
            onConsumeFocus={() => setFocusedSkillId(null)}
          />
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

/**
 * Auth-mode badge + menu. The badge is the current auth label
 * (subscription / api key); clicking it pops a small dropdown holding
 * the "Settings" entry that used to live in the tab bar. The badge gets
 * accent styling when Settings is the active view so the user can still
 * tell where they are without a dedicated tab.
 */
function AuthBadgeMenu({
  label,
  settingsActive,
  onOpenSettings,
}: {
  label: string;
  settingsActive: boolean;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="shell__auth-wrap" ref={wrapRef}>
      <button
        className={`shell__auth-badge${
          settingsActive ? ' shell__auth-badge--active' : ''
        }`}
        onClick={() => setOpen((v) => !v)}
        title="Auth mode · click for Settings"
      >
        {label}
        <span className="shell__auth-caret">▾</span>
      </button>
      {open && (
        <div className="shell__auth-menu">
          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            title="Preferences · Modules · Integrations · API"
          >
            ⚙ Settings
            <span className="shell__auth-hint">
              Preferences · Modules · Integrations · API
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
