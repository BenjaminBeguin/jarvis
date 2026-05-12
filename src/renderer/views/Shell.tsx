import { useState } from 'react';

import { Observatory } from './Observatory';
import { Routines } from './Routines';

type Tab = 'observatory' | 'routines';

export function Shell() {
  const [tab, setTab] = useState<Tab>('observatory');
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
        <button
          className="shell__palette-hint"
          onClick={() => void window.jarvis.openPalette()}
          title="Open command palette"
        >
          ⌘⇧J
        </button>
      </nav>
      <div className="shell__body">
        {tab === 'observatory' ? <Observatory /> : <Routines />}
      </div>
    </div>
  );
}
