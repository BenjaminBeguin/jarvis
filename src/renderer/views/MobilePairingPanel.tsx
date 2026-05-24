import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';

import { toast } from './Toaster';

const HOSTNAME_KEY = 'jarvis.mobile.hostname';
const API_PORT = 4747;
const DEV_PWA_PORT = 3010;

/**
 * Settings → Mobile. Shows a QR code the user scans from the
 * phone's camera app — opens the PWA at `<pwa-url>/#/mobile?pair=
 * <base64-json>` and the PWA persists the embedded `{ baseUrl,
 * token }` to localStorage.
 *
 * Two pieces the user has to provide:
 *   - Their Tailscale hostname (e.g. `laptop.tail-net.ts.net`).
 *     We can't auto-detect it without invoking `tailscale status`,
 *     so we ask once + remember in localStorage.
 *   - Which build to point the QR at — dev (vite, port 3010) or
 *     prod (HTTP server, port 4747). Defaulted by Vite's DEV flag.
 *
 * Bearer token comes from the existing httpApiStatus IPC. We
 * never display it as plaintext — the QR encodes it but the
 * panel only shows the URL up to the pair payload prefix.
 */
export function MobilePairingPanel() {
  const [hostname, setHostname] = useState<string>(() => {
    try {
      return localStorage.getItem(HOSTNAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [token, setToken] = useState<string>('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [target, setTarget] = useState<'dev' | 'prod'>(() =>
    import.meta.env.DEV ? 'dev' : 'prod',
  );
  const [qrSvg, setQrSvg] = useState<string>('');

  useEffect(() => {
    void window.jarvis
      .httpApiStatus()
      .then((s) => {
        if (s.token) setToken(s.token);
        else setTokenError('No API token issued yet — check Settings → API.');
      })
      .catch((err: unknown) => {
        setTokenError(
          err instanceof Error ? err.message : 'Could not load token.',
        );
      });
  }, []);

  useEffect(() => {
    try {
      if (hostname) localStorage.setItem(HOSTNAME_KEY, hostname);
    } catch {
      /* private mode, no biggie */
    }
  }, [hostname]);

  // Compose the URLs. The PWA loads at whatever serves the
  // renderer; API calls go to the HTTP server at :4747.
  const cleanedHost = useMemo(() => hostname.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), [hostname]);
  const apiUrl = cleanedHost ? `http://${cleanedHost}:${API_PORT}` : '';
  const pwaOrigin = cleanedHost
    ? target === 'dev'
      ? `http://${cleanedHost}:${DEV_PWA_PORT}`
      : `http://${cleanedHost}:${API_PORT}/mobile`
    : '';
  // The PWA hash route the QR resolves to. Dev mode is bare
  // origin + hash, prod is HTTP-server-served renderer at /mobile
  // (handled by a later commit).
  const pairPayload = useMemo(() => {
    if (!apiUrl || !token) return '';
    return btoa(JSON.stringify({ baseUrl: apiUrl, token }));
  }, [apiUrl, token]);
  const qrTarget = useMemo(() => {
    if (!pwaOrigin || !pairPayload) return '';
    const hashPrefix = target === 'dev' ? '/#/mobile' : '#/mobile';
    return `${pwaOrigin}${hashPrefix}?pair=${pairPayload}`;
  }, [pwaOrigin, pairPayload, target]);

  useEffect(() => {
    if (!qrTarget) {
      setQrSvg('');
      return;
    }
    void QRCode.toString(qrTarget, {
      type: 'svg',
      margin: 1,
      width: 280,
      color: { dark: '#00d4ff', light: '#04070b' },
      errorCorrectionLevel: 'M',
    }).then(setQrSvg);
  }, [qrTarget]);

  const copyUrl = async () => {
    if (!qrTarget) return;
    try {
      await navigator.clipboard.writeText(qrTarget);
      toast({ message: 'Pairing URL copied' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="mobile-pairing">
      <h3>Pair phone</h3>
      <p className="settings__hint">
        Scan this QR from your phone (Camera app on iOS, Google Lens
        on Android) once Tailscale is installed on both devices and
        signed into the same account. The PWA opens, saves the
        token, and stays signed in.
      </p>

      <label className="mobile-pairing__field">
        <span>Mac Tailscale hostname</span>
        <input
          type="text"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="laptop.tail-net.ts.net"
          spellCheck={false}
          autoCapitalize="off"
        />
        <span className="settings__hint settings__hint--dim">
          From Tailscale's menu-bar app → your Mac. Without the
          protocol or port.
        </span>
      </label>

      <div className="mobile-pairing__target">
        <span>Point QR at</span>
        <label>
          <input
            type="radio"
            name="pair-target"
            checked={target === 'dev'}
            onChange={() => setTarget('dev')}
          />
          Dev server (vite :{DEV_PWA_PORT})
        </label>
        <label>
          <input
            type="radio"
            name="pair-target"
            checked={target === 'prod'}
            onChange={() => setTarget('prod')}
          />
          Production build (:{API_PORT}/mobile)
        </label>
      </div>

      {tokenError && (
        <div className="settings__hint" style={{ color: 'var(--bad)' }}>
          {tokenError}
        </div>
      )}

      {qrTarget && (
        <div className="mobile-pairing__qr">
          <div
            className="mobile-pairing__qr-svg"
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
          <code className="mobile-pairing__qr-url">
            {pwaOrigin}/#/mobile?pair=…
          </code>
          <button
            type="button"
            className="mobile-pairing__copy"
            onClick={() => void copyUrl()}
          >
            Copy full URL
          </button>
        </div>
      )}

      {!cleanedHost && (
        <div className="settings__hint settings__hint--dim">
          Enter your Tailscale hostname above to generate the QR.
        </div>
      )}
    </div>
  );
}
