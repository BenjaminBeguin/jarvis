import { useEffect, useRef, useState } from 'react';

import type { AppMode, AppStatus, ModuleSummary, ProjectDef } from '../../shared/types';
import { getModulePage } from '../modules/registry';
import { ApprovalHud } from './autopilot/ApprovalHud';
import { BatchApprovalHud } from './autopilot/BatchApprovalHud';
import { ConversationChips } from './conversation/ConversationChips';
import { ConversationSidebar } from './conversation/ConversationSidebar';
import { Inbox } from './Inbox';
import { Logo } from './Logo';
import { MeetingOverlay } from './MeetingOverlay';
import { MeetingPrompt } from './MeetingPrompt';
import { NewProjectDialog } from './projects/NewProjectDialog';
import { Projects } from './projects/Projects';
import { ScopePicker } from './projects/ScopePicker';
import { Activity } from './Activity';
import { Dashboard } from './Dashboard';
import { Drafts } from './Drafts';
import { FlowStream } from './FlowStream';
import { Settings } from './Settings';
import { Sidebar, type SidebarSection } from './Sidebar';
import { Skills } from './Skills';
import { Workflows } from './Workflows';
import { toast } from './Toaster';
import { Toaster } from './Toaster';
import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab =
  | 'dashboard'
  | 'observatory'
  | 'ai-agent'
  | 'inbox'
  | 'drafts'
  | 'activity'
  | 'projects'
  | 'routines'
  | 'skills'
  | 'workflows'
  | 'settings';

interface Props {
  status: AppStatus;
}

export function Shell({ status }: Props) {
  // Dashboard is the home. The retired Now tab's bands collapsed back
  // into the Inbox (Meeting strip + Awaiting strip) — that surface
  // wasn't worth the duplication.
  const [tab, setTab] = useState<Tab>('dashboard');
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);
  /** When set, the Skills view opens with this skill selected and scrolls
   * the list to it. Set by deep-link nav from Briefings / Routines. */
  const [focusedSkillId, setFocusedSkillId] = useState<string | null>(null);
  /** Deep-link target for Settings — set when something dispatches
   *  jarvis:navigate with a settingsSection field. Consumed on the
   *  next Settings render and cleared so it doesn't sticky. */
  const [pendingSettingsSection, setPendingSettingsSection] = useState<
    string | null
  >(null);
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

  // Pending-draft count for the sidebar badge. Re-counts on every
  // drafts:changed broadcast — cheap because listDrafts is a SQLite
  // SELECT with a status filter.
  const [draftsPending, setDraftsPending] = useState(0);
  useEffect(() => {
    const refresh = () => {
      void window.jarvis
        .listDrafts({ status: ['pending', 'failed'] })
        .then((list) => setDraftsPending(list.length))
        .catch(() => setDraftsPending(0));
    };
    refresh();
    return window.jarvis.onDraftsChanged(refresh);
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

  // Navigation history — delegated to `window.history` so the global
  // back/forward arrows compose with sub-view navigation. Each Shell
  // tab/moduleId change pushes a `{ shellNav: … }` state; views like
  // Workflows and Routines push their own state objects (`{ wfId }`,
  // `{ rtId }`) when the user drills into a detail row. The arrows
  // call `window.history.back/forward()`, which fires popstate that
  // each layer handles independently — sub-views pop their detail
  // back to the list first, then the Shell pops to the previous tab.
  //
  // Arrows are always enabled. There's no public API to read the
  // current window.history position, and accurately disabling at the
  // boundaries would require every sub-view to notify the Shell on
  // push (via context). Browser back/forward at the boundary is a
  // silent no-op, which is acceptable here.
  const skipHistoryPushRef = useRef(false);

  // Seed the browser history entry on mount so the first pop has a
  // shellNav state to restore from (instead of `null`, which would
  // leave the Shell in an undefined-tab limbo).
  useEffect(() => {
    const existing = (window.history.state ?? null) as {
      shellNav?: { tab: Tab; moduleId: string | null };
    } | null;
    if (!existing?.shellNav) {
      window.history.replaceState(
        { shellNav: { tab, moduleId: openModuleId } },
        '',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push tab/moduleId changes to window.history so back/forward
  // naturally walks them. Dedupe identical consecutive entries.
  useEffect(() => {
    if (skipHistoryPushRef.current) {
      skipHistoryPushRef.current = false;
      return;
    }
    const current = (window.history.state ?? null) as {
      shellNav?: { tab: Tab; moduleId: string | null };
    } | null;
    if (
      current?.shellNav &&
      current.shellNav.tab === tab &&
      current.shellNav.moduleId === openModuleId
    ) {
      return;
    }
    window.history.pushState(
      { shellNav: { tab, moduleId: openModuleId } },
      '',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, openModuleId]);

  // Listen to popstate. Shell-level entries restore tab/moduleId;
  // sub-view entries are ignored here — each sub-view (Workflows,
  // Routines, …) has its own popstate listener handling its state.
  useEffect(() => {
    const onPop = (e: PopStateEvent): void => {
      const state = (e.state ?? null) as {
        shellNav?: { tab: Tab; moduleId: string | null };
      } | null;
      if (state?.shellNav) {
        skipHistoryPushRef.current = true;
        setTab(state.shellNav.tab);
        setOpenModuleId(state.shellNav.moduleId);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const goBack = () => window.history.back();
  const goForward = () => window.history.forward();
  const canBack = true;
  const canForward = true;

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
      /** When opening Settings, which section to land on (general,
       *  preferences, modules, integrations, api, builder, …). */
      settingsSection?: string;
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
      if (payload.tab === 'settings' && payload.settingsSection) {
        setPendingSettingsSection(payload.settingsSection);
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

  // Close the open module page if it gets disabled or unregistered
  // (modulesChanged broadcast). Without this, the user could be
  // stranded on a page whose backing module is gone.
  useEffect(() => {
    if (!openModuleId) return;
    let cancelled = false;
    const sync = async () => {
      const all = await window.jarvis.listModules();
      if (cancelled) return;
      const m = all.find((x) => x.id === openModuleId);
      if (!m || !m.enabled || !m.hasPage) {
        setOpenModuleId(null);
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

  const [afk, setAfk] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.jarvis.getAfk().then((v) => {
      if (!cancelled) setAfk(v);
    });
    const off = window.jarvis.onAfkChanged((v) => setAfk(v));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  const toggleAfk = (): void => {
    const next = !afk;
    setAfk(next);
    void window.jarvis.setAfk(next);
  };

  // Tri-state operating mode (paused / running / autopilot). Same
  // value the tray and Telegram bot toggle. Routines + scheduled
  // actions respect `paused`; autopilot-triggered workflows fire
  // only when `autopilot`. User-initiated palette/voice always runs.
  const [appMode, setAppModeState] = useState<AppMode>('running');
  useEffect(() => {
    let cancelled = false;
    void window.jarvis.getAppMode().then((v) => {
      if (!cancelled) setAppModeState(v);
    });
    const off = window.jarvis.onAppModeChanged((v) => setAppModeState(v));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  const setMode = (next: AppMode): void => {
    if (next === appMode) return;
    setAppModeState(next);
    void window.jarvis.setAppMode(next);
  };

  // Whether AFK has anywhere to mirror events. Today the only subscriber
  // is the Telegram bot; AFK with no subscriber would be a confusing
  // no-op, so hide the toggle until the bot is configured.
  // "Ready" = module enabled + token in Keychain + at least one allowed
  // chat id. Refresh on modulesChanged (covers token writes too — those
  // reload the module which broadcasts changed).
  const [telegramReady, setTelegramReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const [list, hasToken] = await Promise.all([
        window.jarvis.listModules(),
        window.jarvis.hasTelegramBotToken(),
      ]);
      if (cancelled) return;
      const tg = list.find((m) => m.id === 'telegram-bot');
      const allowed = String((tg?.settingsValues?.allowedChatIds ?? '') as string).trim();
      setTelegramReady(!!tg?.enabled && hasToken && allowed.length > 0);
    };
    void refresh();
    const off = window.jarvis.onModulesChanged(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const PageComponent = openModuleId ? getModulePage(openModuleId) : null;

  /**
   * Sidebar sections. Three groups so the vertical rail reads at a
   * glance — main pages on top, capture-style module pages in the
   * middle, automation authoring at the bottom. Module pages get
   * shorter labels here than their module.name (e.g. "Notes" instead
   * of "Notes & Reminders") so they fit cleanly in the rail.
   */
  const MODULE_SHORT_LABEL: Record<string, string> = {
    'quick-note': 'Notes',
    'meeting-recorder': 'Meetings',
    calendar: 'Calendar',
  };
  const MODULE_ICON: Record<string, string> = {
    'quick-note': 'N',
    'meeting-recorder': 'M',
    calendar: 'C',
  };

  const sidebarSections: SidebarSection[] = [
    {
      id: 'main',
      items: [
        {
          id: 'dashboard',
          label: 'Dashboard',
          icon: 'D',
          isActive: tab === 'dashboard' && !openModuleId,
          onClick: () => {
            setTab('dashboard');
            setOpenModuleId(null);
          },
          title: '⌘1 · Curated home — pinned briefings + inbox + routines',
        },
        {
          id: 'inbox',
          label: 'Inbox',
          icon: 'I',
          isActive: tab === 'inbox' && !openModuleId,
          onClick: () => {
            setTab('inbox');
            setOpenModuleId(null);
          },
          title: '⌘3 · Triage feed (PRs / reminders / Linear / failed routines)',
        },
        {
          id: 'drafts',
          label: 'Drafts',
          icon: 'D',
          isActive: tab === 'drafts' && !openModuleId,
          onClick: () => {
            setTab('drafts');
            setOpenModuleId(null);
          },
          title: 'AI-generated drafts waiting for your review',
          count: draftsPending,
        },
        {
          id: 'observatory',
          label: 'Observatory',
          icon: 'O',
          isActive: tab === 'observatory' && !openModuleId,
          onClick: () => {
            setTab('observatory');
            setOpenModuleId(null);
          },
          title: 'Live river of events flowing through Jarvis',
        },
        {
          id: 'ai-agent',
          label: 'AI Agent',
          icon: 'A',
          isActive: tab === 'ai-agent' && !openModuleId,
          onClick: () => {
            setTab('ai-agent');
            setOpenModuleId(null);
          },
          title: 'Recent + running agent tasks · constellation + list view',
        },
      ],
    },
    {
      id: 'capture',
      label: 'Capture',
      items: moduleList
        .filter((m) => m.hasPage && m.enabled)
        .map((m) => ({
          id: `module:${m.id}`,
          label: MODULE_SHORT_LABEL[m.id] ?? m.name,
          icon: MODULE_ICON[m.id] ?? m.name.charAt(0).toUpperCase(),
          isActive: openModuleId === m.id,
          onClick: () => setOpenModuleId(m.id),
          title: m.description,
        })),
    },
    {
      id: 'build',
      label: 'Build',
      items: [
        {
          id: 'routines',
          label: 'Routines',
          icon: 'R',
          isActive: tab === 'routines' && !openModuleId,
          onClick: () => {
            setTab('routines');
            setOpenModuleId(null);
          },
          title: 'Skills on a schedule',
        },
        {
          id: 'skills',
          label: 'Skills',
          icon: 'S',
          isActive: tab === 'skills' && !openModuleId,
          onClick: () => {
            setTab('skills');
            setOpenModuleId(null);
            setFocusedSkillId(null);
          },
          title: 'SKILL.md prompts (the things Jarvis runs)',
        },
        {
          id: 'workflows',
          label: 'Workflows',
          icon: 'W',
          isActive: tab === 'workflows' && !openModuleId,
          onClick: () => {
            setTab('workflows');
            setOpenModuleId(null);
          },
          title: 'Trigger + pipeline of nodes — every cron-fetch workflow lives here',
        },
      ],
    },
  ];

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
          <div
            className="shell__mode"
            role="radiogroup"
            aria-label="Operating mode"
          >
            <button
              type="button"
              role="radio"
              aria-checked={appMode === 'paused'}
              className={`shell__mode-seg${appMode === 'paused' ? ' shell__mode-seg--on' : ''}`}
              onClick={() => setMode('paused')}
              title="Paused — silence routines + scheduled actions"
            >
              ⏸
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={appMode === 'running'}
              className={`shell__mode-seg${appMode === 'running' ? ' shell__mode-seg--on' : ''}`}
              onClick={() => setMode('running')}
              title="Running — normal behavior"
            >
              ▶
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={appMode === 'autopilot'}
              className={`shell__mode-seg shell__mode-seg--autopilot${appMode === 'autopilot' ? ' shell__mode-seg--on' : ''}`}
              onClick={() => setMode('autopilot')}
              title="Autopilot — act on incoming asks (Slack DMs, PR reviews) with approval prompts"
            >
              ⚡
            </button>
          </div>
          {telegramReady && (
            <button
              className={`shell__afk-btn${afk ? ' shell__afk-btn--on' : ''}`}
              onClick={toggleAfk}
              title={
                afk
                  ? 'AFK on — reminders + cockpit prompts + task results all mirror to your Telegram bot. Click to turn off.'
                  : 'AFK off — only events tied to chats your bot started reach the phone. Click to mirror everything (reminders firing, palette tasks asking for confirmation, etc.) to your bot.'
              }
              aria-label={afk ? 'Turn off AFK mode' : 'Turn on AFK mode'}
            >
              <svg viewBox="0 0 18 16" aria-hidden width="22" height="14">
                {/* phone body */}
                <rect
                  x="5"
                  y="1.5"
                  width="8"
                  height="13"
                  rx="1.5"
                  fill={afk ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                {/* speaker slot */}
                <line
                  x1="8"
                  y1="3"
                  x2="10"
                  y2="3"
                  stroke={afk ? 'var(--bg, #000)' : 'currentColor'}
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
                {/* signal waves only when on */}
                {afk && (
                  <>
                    <path
                      d="M14.5 5.5 Q15.5 7 14.5 8.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                    <path
                      d="M16 4 Q17.4 7 16 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      opacity="0.6"
                    />
                  </>
                )}
              </svg>
              <span className="shell__afk-label">AFK</span>
              <span className={`shell__afk-dot${afk ? ' shell__afk-dot--on' : ''}`} aria-hidden />
            </button>
          )}
          <button
            className={`shell__auth-badge${
              tab === 'settings' && !openModuleId
                ? ' shell__auth-badge--active'
                : ''
            }`}
            onClick={() => {
              setTab('settings');
              setOpenModuleId(null);
            }}
            title={`Settings · auth: ${badge}`}
            type="button"
          >
            Settings
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

      <div className="shell__main">
        <Sidebar sections={sidebarSections} />
        <div className="shell__body">
        {openModuleId && PageComponent ? (
          <PageComponent />
        ) : tab === 'dashboard' ? (
          <Dashboard />
        ) : tab === 'observatory' ? (
          <FlowStream />
        ) : tab === 'ai-agent' ? (
          <Observatory />
        ) : tab === 'inbox' ? (
          <Inbox />
        ) : tab === 'drafts' ? (
          <Drafts />
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
        ) : tab === 'workflows' ? (
          <Workflows />
        ) : (
          <Settings
            status={status}
            onOpenModulePage={(id) => setOpenModuleId(id)}
            initialSection={
              (pendingSettingsSection as
                | 'general'
                | 'preferences'
                | 'notifications'
                | 'inbox'
                | 'modules'
                | 'integrations'
                | 'api'
                | 'spend'
                | 'builder'
                | undefined) ?? undefined
            }
            onInitialSectionConsumed={() => setPendingSettingsSection(null)}
          />
        )}
        </div>
      </div>
      <MeetingOverlay />
      <MeetingPrompt />
      <ApprovalHud />
      <BatchApprovalHud />
      <ConversationSidebar />
      <ConversationChips />
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
