import { useState } from 'react';

import { navigateMobile } from './MobileApp';
import type { MobileAuth } from './types';

interface Props {
  auth: MobileAuth;
  onSignOut: () => void;
}

/**
 * In-PWA help / setup overview. Reachable from the header `?` glyph.
 * Three reasons it lives here vs only in docs/mobile.md:
 *   - The phone has no docs viewer; the user can't open the repo.
 *   - Notification permission, install-to-home-screen, and "what URL
 *     am I pointed at" are phone-specific things the docs file can't
 *     show contextually.
 *   - Re-pairing + sign-out are useful escape hatches if something
 *     drifts — keeping them here means no detour to the desktop.
 */
export function MobileHelp({ auth, onSignOut }: Props) {
  const platform = detectPlatform();
  const notif = useNotifPermission();

  return (
    <div className="mobile-help">
      <div className="mobile-help__head">
        <button
          type="button"
          className="mobile-help__back"
          onClick={() => navigateMobile('inbox')}
          aria-label="Back"
        >
          ←
        </button>
        <h2>Help &amp; setup</h2>
      </div>

      <Section title="What this is">
        <p>
          A touch-tuned view of Jarvis. The Mac stays the brain; this PWA
          is a remote control + viewer over your Tailscale tailnet. No
          cloud relay, no public URL.
        </p>
      </Section>

      <Section title="Paired with">
        <code className="mobile-help__code">{auth.baseUrl}</code>
        <p className="mobile-help__dim">
          That's the Mac's HTTP API at port 4747. If it ever goes wrong,
          sign out below and re-scan the QR from the Mac's Settings →
          Mobile panel.
        </p>
      </Section>

      <Section title="Install to home screen">
        {platform === 'ios' ? (
          <ol>
            <li>
              Tap the Safari <strong>Share</strong> icon (square with an
              arrow) at the bottom.
            </li>
            <li>
              Scroll to <strong>Add to Home Screen</strong>.
            </li>
            <li>Confirm. The Jarvis icon installs.</li>
            <li>
              Open it from the home screen — the URL bar disappears and
              Web Push works.
            </li>
          </ol>
        ) : platform === 'android' ? (
          <ol>
            <li>
              Tap the <strong>⋮</strong> menu in Chrome.
            </li>
            <li>
              Pick <strong>Install app</strong> (or <em>Add to Home
              Screen</em>).
            </li>
            <li>Confirm. The PWA installs standalone.</li>
          </ol>
        ) : (
          <ol>
            <li>
              In Chrome's URL bar, click the install icon (computer with
              a down arrow) — or <strong>⋮ menu → Install Jarvis</strong>.
            </li>
            <li>Confirm. The PWA opens as a standalone window.</li>
          </ol>
        )}
      </Section>

      <Section title="Notifications">
        <p className="mobile-help__dim">
          Current permission: <code>{notif}</code>.
        </p>
        {notif === 'denied' && (
          <p>
            Notifications are blocked. {platform === 'ios'
              ? 'Open iOS Settings → Notifications → Jarvis to allow.'
              : platform === 'android'
                ? 'Open the Android app info for Chrome (or the installed PWA) → Notifications.'
                : 'Open Chrome → Settings → Privacy → Site settings → Notifications, find this site, allow.'}
          </p>
        )}
        {notif === 'default' && (
          <p>
            Tap below to enable. The PWA will subscribe to push fan-out
            so the Mac can alert you the same way the desktop does.
          </p>
        )}
        {notif === 'granted' && (
          <p className="mobile-help__dim">
            Push fan-out is live. Every <code>notifier.post()</code> on the
            Mac shows up here. Pause on the Mac silences cron-fired
            sources; task lifecycle still gets through.
          </p>
        )}
        {notif === 'default' && (
          <button
            type="button"
            className="mobile-help__btn"
            onClick={() => {
              void Notification.requestPermission().then(() => {
                window.location.reload();
              });
            }}
          >
            Enable notifications
          </button>
        )}
      </Section>

      <Section title="Microphone (Dictate tab)">
        <p>
          First tap on the mic orb asks for permission. If you miss it:
          {platform === 'ios'
            ? ' iOS Settings → Safari → Microphone, allow.'
            : platform === 'android'
              ? ' Long-press the PWA icon → App info → Permissions → Microphone.'
              : ' Chrome → URL bar lock icon → Site settings → Microphone, allow.'}
        </p>
      </Section>

      <Section title="Troubleshooting">
        <ul className="mobile-help__list">
          <li>
            <strong>Inbox shows "Failed to fetch":</strong> the Mac isn't
            reachable. Confirm Tailscale is up on both sides, then sign
            out + re-pair.
          </li>
          <li>
            <strong>"Reconnecting…" never resolves:</strong> the SSE
            stream dropped. Pull-to-refresh forces an immediate fetch.
            macOS may suspend the HTTP server when the lid is closed;
            wake the Mac.
          </li>
          <li>
            <strong>Push works on Mac but not phone:</strong> on iOS the
            PWA must be installed to the home screen — not just an open
            Safari tab.
          </li>
          <li>
            <strong>Dictate fails with "audio too short":</strong> hold
            the orb longer (the VAD auto-stop needs ≥ 300 ms of speech).
          </li>
        </ul>
      </Section>

      <Section title="Re-pair / sign out">
        <p>
          Clears the saved bearer token + device id from this phone. The
          Mac side keeps the push subscription store; it'll be re-issued
          on next pairing.
        </p>
        <button
          type="button"
          className="mobile-help__btn mobile-help__btn--danger"
          onClick={onSignOut}
        >
          Sign out
        </button>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mobile-help__section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

type Platform = 'ios' | 'android' | 'desktop';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

type NotifPerm = 'granted' | 'denied' | 'default' | 'unsupported';

function useNotifPermission(): NotifPerm {
  const [state] = useState<NotifPerm>(() => {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission as NotifPerm;
  });
  return state;
}
