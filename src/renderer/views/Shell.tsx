import { useEffect, useState } from 'react';

import type { AppStatus } from '../../shared/types';
import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab = 'observatory' | 'routines';

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
  const [switchOpen, setSwitchOpen] = useState(false);
  const [clock, setClock] = useState(() => formatClock(new Date()));

  useEffect(() => {
    const id = setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  const switchAuth = async (mode: 'subscription' | 'api-key') => {
    try {
      await window.jarvis.setAuthMode(mode);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitchOpen(false);
    }
  };

  const badge =
    status.authMode === 'subscription' ? 'subscription' : 'api key';

  return (
    <div className="shell">
      <nav className="shell__nav">
        <div className="shell__brand">
          <Reticle />
          JARVIS
        </div>
        <div className="shell__tabs">
          <button
            className={`shell__tab${tab === 'observatory' ? ' shell__tab--active' : ''}`}
            onClick={() => setTab('observatory')}
          >
            Observatory
          </button>
          <button
            className={`shell__tab${tab === 'routines' ? ' shell__tab--active' : ''}`}
            onClick={() => setTab('routines')}
          >
            Routines
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
                  disabled={!status.claudeBinaryPath}
                  onClick={() => void switchAuth('subscription')}
                >
                  Subscription
                  {!status.claudeBinaryPath && (
                    <span className="shell__auth-hint">claude CLI not found</span>
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
      <div className="shell__body">
        {tab === 'observatory' ? <Observatory /> : <Routines />}
      </div>
    </div>
  );
}
