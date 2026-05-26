import { useEffect, useState } from 'react';

import { toast } from './Toaster';

/**
 * Settings → Browser. Step-by-step install + setup for the Chrome
 * extension that pings Jarvis when the user joins a Meet / Zoom /
 * Teams / Whereby call.
 *
 * Three jobs:
 *   1. Tell the user what the extension does + where it lives on
 *      disk (so they can point chrome://extensions/ → "Load
 *      unpacked" at it).
 *   2. Surface the base URL + bearer token the popup needs, with
 *      copy buttons. These come from the existing httpApiStatus IPC
 *      (same source the Mobile pairing panel uses).
 *   3. Provide a "Reveal in Finder" affordance so the user doesn't
 *      have to hunt for the unpacked folder path.
 *
 * Token is shown in plaintext here, deliberately — this panel is
 * inside the desktop app under Settings, and the user needs to copy
 * the value into the extension's popup. Same threat model as the
 * Mobile pairing QR.
 */
export function BrowserExtensionPanel() {
  const [path, setPath] = useState<string>('');
  const [exists, setExists] = useState<boolean>(true);
  const [baseUrl, setBaseUrl] = useState<string>('http://127.0.0.1:4747');
  const [token, setToken] = useState<string>('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);

  useEffect(() => {
    void window.jarvis
      .getChromeExtensionInfo()
      .then((info) => {
        setPath(info.path);
        setExists(info.exists);
      })
      .catch(() => {
        // Old build without the IPC — fall back to a hint.
        setExists(false);
      });
    void window.jarvis
      .httpApiStatus()
      .then((s) => {
        if (s.url) setBaseUrl(s.url);
        if (s.token) setToken(s.token);
        else setTokenError('No API token issued yet — check Settings → API.');
      })
      .catch((err: unknown) => {
        setTokenError(
          err instanceof Error ? err.message : 'Could not load token.',
        );
      });
  }, []);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ kind: 'success', message: `${label} copied.` });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const reveal = async () => {
    const res = await window.jarvis.revealChromeExtensionFolder();
    if (!res.ok) {
      toast({
        kind: 'error',
        message: res.message ?? 'Could not reveal the folder.',
      });
    }
  };

  return (
    <div className="settings__section browser-ext">
      <h3>Chrome extension</h3>
      <p className="settings__hint">
        A tiny extension that pings Jarvis when you join a Meet / Zoom /
        Teams / Whereby call, so the desktop app can offer to record
        without you reaching for the mic. Open-source, lives in this
        repo — not a Chrome Web Store install.
      </p>

      <ol className="browser-ext__steps">
        <li>
          <div className="browser-ext__step-head">
            <span className="browser-ext__step-n">1</span>
            <span>Reveal the extension folder</span>
          </div>
          <div className="browser-ext__step-body">
            {exists ? (
              <>
                <code className="browser-ext__path" title={path}>
                  {path}
                </code>
                <button
                  type="button"
                  className="browser-ext__btn"
                  onClick={() => void reveal()}
                >
                  Reveal in Finder
                </button>
              </>
            ) : (
              <div className="browser-ext__warn">
                {path ? (
                  <>
                    Couldn't find <code>{path}</code>. This is normal in a
                    packaged build — clone the repo and load{' '}
                    <code>chrome-extension/</code> from the source tree
                    instead.
                  </>
                ) : (
                  'Could not resolve the extension path.'
                )}
              </div>
            )}
          </div>
        </li>

        <li>
          <div className="browser-ext__step-head">
            <span className="browser-ext__step-n">2</span>
            <span>Load it in Chrome</span>
          </div>
          <div className="browser-ext__step-body">
            <ul className="browser-ext__sublist">
              <li>
                Open{' '}
                <button
                  type="button"
                  className="browser-ext__inline-link"
                  onClick={() =>
                    void window.jarvis.openExternal(
                      'chrome://extensions/',
                    )
                  }
                  title="chrome://extensions/ — Chrome won't actually navigate from this click (chrome:// is blocked for security), so paste it into the URL bar manually."
                >
                  chrome://extensions/
                </button>{' '}
                in Chrome. (Chrome blocks app-launched navigation to{' '}
                <code>chrome://</code> URLs — paste it into the address
                bar.)
              </li>
              <li>
                Toggle <strong>Developer mode</strong> on (top right).
              </li>
              <li>
                Click <strong>Load unpacked</strong> → pick the
                <code> chrome-extension/ </code>folder from step 1.
              </li>
            </ul>
          </div>
        </li>

        <li>
          <div className="browser-ext__step-head">
            <span className="browser-ext__step-n">3</span>
            <span>Wire it to this Jarvis</span>
          </div>
          <div className="browser-ext__step-body">
            <p className="browser-ext__sub">
              Click the Jarvis extension icon (you may need to pin it
              first) and paste these into the popup:
            </p>

            <div className="browser-ext__field">
              <span className="browser-ext__field-label">Base URL</span>
              <code className="browser-ext__field-value">{baseUrl}</code>
              <button
                type="button"
                className="browser-ext__btn browser-ext__btn--small"
                onClick={() => void copy('Base URL', baseUrl)}
              >
                Copy
              </button>
            </div>

            <div className="browser-ext__field">
              <span className="browser-ext__field-label">Bearer token</span>
              <code className="browser-ext__field-value browser-ext__field-value--secret">
                {token
                  ? tokenVisible
                    ? token
                    : '•'.repeat(Math.min(token.length, 32))
                  : tokenError ?? '—'}
              </code>
              <button
                type="button"
                className="browser-ext__btn browser-ext__btn--small"
                onClick={() => setTokenVisible((v) => !v)}
                disabled={!token}
              >
                {tokenVisible ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                className="browser-ext__btn browser-ext__btn--small"
                onClick={() => void copy('Bearer token', token)}
                disabled={!token}
              >
                Copy
              </button>
            </div>

            <p className="browser-ext__sub">
              Hit <strong>Save</strong> in the popup, then{' '}
              <strong>Test</strong> — you should see a green
              "connected" banner. If you ever rotate the API token
              (Settings → API), come back here and re-paste.
            </p>
          </div>
        </li>

        <li>
          <div className="browser-ext__step-head">
            <span className="browser-ext__step-n">4</span>
            <span>Try it</span>
          </div>
          <div className="browser-ext__step-body">
            <p className="browser-ext__sub">
              Open a Meet / Zoom / Teams call. Jarvis pops a "Record
              this meeting?" notification when the page loads — click
              Record and the meeting-recorder module takes over.
            </p>
          </div>
        </li>
      </ol>

      <div className="browser-ext__troubleshoot">
        <h4>Not working?</h4>
        <ul>
          <li>
            <strong>"Failed to fetch" in the popup.</strong> The HTTP
            API isn't running. Check Settings → API — the toggle should
            be on.
          </li>
          <li>
            <strong>Extension loads but no notification on Zoom.</strong>{' '}
            Reload the meeting tab once after enabling the extension.
            Content scripts only attach to NEW page loads.
          </li>
          <li>
            <strong>Using Tailscale to reach Jarvis from another Mac?</strong>{' '}
            Paste your <code>&lt;mac&gt;.&lt;tail-net&gt;.ts.net:4747</code>{' '}
            URL into the popup's Base URL instead of localhost.
          </li>
        </ul>
      </div>
    </div>
  );
}
