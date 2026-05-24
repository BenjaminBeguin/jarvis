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
        Open <strong>Settings → Mobile</strong> on your Mac and scan the
        QR code with your camera. If you've already done that and landed
        here, paste the pairing string below.
      </p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="Pairing string (base64 or JSON)"
        rows={4}
        spellCheck={false}
        autoCapitalize="off"
      />
      {error && <div className="mobile-login__error">{error}</div>}
      <button type="button" className="mobile-login__submit" onClick={submit}>
        Sign in
      </button>
    </div>
  );
}
