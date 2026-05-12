import { useState } from 'react';

import type { AppStatus } from '../../shared/types';
import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab = 'observatory' | 'routines';

interface Props {
  status: AppStatus;
}

export function Shell({ status }: Props) {
  const [tab, setTab] = useState<Tab>('observatory');
  const [switchOpen, setSwitchOpen] = useState(false);

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
        <div className="shell__brand">Jarvis</div>
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
