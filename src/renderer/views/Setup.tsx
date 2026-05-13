import { useEffect, useState } from 'react';

import type { AppStatus } from '../../shared/types';

interface Props {
  status: AppStatus;
}

type Mode = 'choose' | 'api-key' | 'subscription-token';

export function Setup({ status }: Props) {
  const [mode, setMode] = useState<Mode>('choose');
  const [apiKey, setApiKey] = useState('');
  const [subToken, setSubToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [mode]);

  const saveApiKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.jarvis.setApiKey(apiKey);
      setApiKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSubscriptionToken = async () => {
    if (!subToken.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.jarvis.setSubscriptionToken(subToken);
      setSubToken('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'api-key') {
    return (
      <div className="setup">
        <h2>Use an Anthropic API key</h2>
        <p>
          Stored in your macOS Keychain. Tasks bill against the Anthropic API
          account that owns the key.
        </p>
        <div className="row">
          <input
            type="password"
            autoFocus
            placeholder="sk-ant-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveApiKey();
            }}
          />
          <button onClick={saveApiKey} disabled={busy || !apiKey.trim()}>
            Save
          </button>
        </div>
        <button
          className="setup__link"
          onClick={() => setMode('choose')}
          disabled={busy}
        >
          ← back
        </button>
        {error && <p className="setup__error">{error}</p>}
      </div>
    );
  }

  if (mode === 'subscription-token') {
    return (
      <div className="setup">
        <h2>Connect your Claude subscription</h2>
        <p>
          In a terminal, run:
        </p>
        <pre className="setup__cmd">claude setup-token</pre>
        <p>
          It opens a browser to authorize your Claude.ai account and prints
          a long-lived token. Paste it here. Stored in your macOS Keychain
          and only used to spawn the <code>claude</code> CLI from Jarvis.
        </p>
        <div className="row">
          <input
            type="password"
            autoFocus
            placeholder="sk-ant-oat… (output of claude setup-token)"
            value={subToken}
            onChange={(e) => setSubToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveSubscriptionToken();
            }}
          />
          <button
            onClick={saveSubscriptionToken}
            disabled={busy || !subToken.trim()}
          >
            Save
          </button>
        </div>
        <button
          className="setup__link"
          onClick={() => setMode('choose')}
          disabled={busy}
        >
          ← back
        </button>
        {error && <p className="setup__error">{error}</p>}
      </div>
    );
  }

  const hasClaude = !!status.claudeBinaryPath;

  return (
    <div className="setup setup--choose">
      <h2>Welcome to Jarvis</h2>
      <p>Pick how Jarvis should authenticate to Claude.</p>
      <div className="setup__cards">
        <button
          className={`setup__card${hasClaude ? ' setup__card--recommended' : ' setup__card--disabled'}`}
          onClick={() => setMode('subscription-token')}
          disabled={!hasClaude || busy}
        >
          <div className="setup__card-title">
            Use my Claude subscription
            {hasClaude && (
              <span className="setup__pill">Recommended</span>
            )}
          </div>
          <div className="setup__card-desc">
            {hasClaude
              ? `Tasks route through your installed claude CLI and bill against your Claude.ai subscription quota. Requires a one-time setup-token paste.`
              : 'Claude Code CLI not detected. Install it from claude.ai/download and run `claude login`, then come back.'}
          </div>
          {status.claudeBinaryPath && (
            <div className="setup__card-meta">{status.claudeBinaryPath}</div>
          )}
        </button>

        <button
          className="setup__card"
          onClick={() => setMode('api-key')}
          disabled={busy}
        >
          <div className="setup__card-title">Use an Anthropic API key</div>
          <div className="setup__card-desc">
            Stored in your macOS Keychain. Tasks bill against the API account
            that owns the key.
          </div>
        </button>
      </div>
      {error && <p className="setup__error">{error}</p>}
    </div>
  );
}
