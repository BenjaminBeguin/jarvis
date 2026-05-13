import { useEffect, useState } from 'react';

import type { AppStatus, ModuleSummary } from '../../shared/types';
import { getModulePage } from '../modules/registry';
import { MeetingOverlay } from './MeetingOverlay';
import { ModulesPage } from './ModulesPage';
import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab = 'observatory' | 'routines' | 'modules';

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
  const [switchOpen, setSwitchOpen] = useState(false);
  const [clock, setClock] = useState(() => formatClock(new Date()));

  useEffect(() => {
    const id = setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => clearInterval(id);
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
            className={`shell__tab${tab === 'routines' && !openModuleId ? ' shell__tab--active' : ''}`}
            onClick={() => {
              setTab('routines');
              setOpenModuleId(null);
            }}
          >
            Routines
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
        <div className="shell__breadcrumb">
          <button
            onClick={() => {
              setOpenModuleId(null);
              setTab('modules');
            }}
            className="shell__breadcrumb-back"
          >
            ← Modules
          </button>
          <span className="shell__breadcrumb-name">
            {openModule?.name ?? openModuleId}
          </span>
        </div>
      )}

      <div className="shell__body">
        {openModuleId && PageComponent ? (
          <PageComponent />
        ) : tab === 'observatory' ? (
          <Observatory />
        ) : tab === 'routines' ? (
          <Routines />
        ) : (
          <ModulesPage onOpenPage={(id) => setOpenModuleId(id)} />
        )}
      </div>
      <MeetingOverlay />
    </div>
  );
}
