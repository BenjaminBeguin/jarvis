/**
 * Mobile PWA local types. Mirrors the shared TrayMenuState shape
 * but lives here so the mobile bundle doesn't pull half of
 * @shared/types in for IPC unions we don't need on the phone.
 */

export type MobileView =
  | 'inbox'
  | 'conversations'
  | 'conversation'
  | 'dictate'
  | 'help';

export interface MobileAuth {
  /** Base URL of the Mac's HTTP API. e.g. `http://laptop.tail-net.ts.net:4747` */
  baseUrl: string;
  /** Bearer token issued by the Mac, paired via QR. */
  token: string;
}
