import { useEffect, useState } from 'react';

import type { AppStatus } from '../../shared/types';

interface Props {
  status: AppStatus;
}

export function Setup({ status }: Props) {
  const [mode, setMode] = useState<'choose' | 'api-key'>('choose');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [mode]);

  const pickSubscription = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.jarvis.setAuthMode('subscription');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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

  const hasClaude = !!status.claudeBinaryPath;

  return (
    <div className="setup setup--choose">
      <h2>Welcome to Jarvis</h2>
      <p>Pick how Jarvis should authenticate to Claude.</p>
      <div className="setup__cards">
        <button
          className={`setup__card${hasClaude ? ' setup__card--recommended' : ' setup__card--disabled'}`}
          onClick={pickSubscription}
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
              ? `Tasks route through your installed claude CLI and bill against your Claude.ai subscription quota.`
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
