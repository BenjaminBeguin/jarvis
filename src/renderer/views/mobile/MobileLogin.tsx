import { useState } from 'react';

import { parseQrPayload } from './auth';
import type { MobileAuth } from './types';

interface Props {
  onPaired: (auth: MobileAuth) => void;
}

/**
 * First-load screen on the phone. The happy path is "user
 * already scanned the QR" — in which case MobileApp consumed
 * ?pair= and we never render here. This is the fallback for
 * when the user lands without that payload (typed the URL,
 * cleared localStorage, etc.). Paste-the-payload manual entry.
 */
export function MobileLogin({ onPaired }: Props) {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setError('Paste the pairing payload from the desktop QR.');
      return;
    }
    // The payload from the QR is `{ baseUrl, token }` JSON,
    // base64-encoded. Accept either the bare JSON OR the
    // base64 form.
    let parsed = parseQrPayload(trimmed);
    if (!parsed) {
      try {
        parsed = parseQrPayload(atob(trimmed));
      } catch {
        /* not base64 */
      }
    }
    if (!parsed) {
      setError(
        "Couldn't read that. From your Mac, copy the pairing URL and paste it here.",
      );
      return;
    }
    onPaired(parsed);
  };

  return (
    <div className="mobile-login">
      <div className="mobile-login__brand">◢ JARVIS</div>
      <h1>Connect your phone</h1>
      <p>
        This is the Jarvis mobile PWA. Pairing is one-shot — once you've
        scanned the QR, the phone stays signed in until you sign out.
      </p>

      <ol className="mobile-login__steps">
        <li>
          Both devices must be on the same <strong>Tailscale</strong>{' '}
          tailnet. App Store / Play Store → install, sign in.
        </li>
        <li>
          On the Mac, open Jarvis → ⚙ <strong>Settings → Mobile</strong>.
        </li>
        <li>
          Enter your Mac's Tailscale hostname, leave the target on{' '}
          <em>Dev</em> (if running <code>pnpm dev</code>) or{' '}
          <em>Production</em>, then scan the QR with this phone's camera.
        </li>
      </ol>

      <details className="mobile-login__manual">
        <summary>Or paste the pairing string manually</summary>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Pairing string (base64 or JSON)"
          rows={4}
          spellCheck={false}
          autoCapitalize="off"
        />
        {error && <div className="mobile-login__error">{error}</div>}
        <button
          type="button"
          className="mobile-login__submit"
          onClick={submit}
        >
          Sign in
        </button>
      </details>

      <p className="mobile-login__foot">
        After sign-in: <strong>Add to Home Screen</strong> so notifications
        + standalone display work.
      </p>
    </div>
  );
}
