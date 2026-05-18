import { createHash, randomBytes } from 'node:crypto';

/**
 * Tiny RFC 7636 helpers. Verifier is 32 bytes of entropy base64url'd
 * (43 chars after stripping padding). Challenge is SHA-256(verifier)
 * base64url'd. Caller sends the challenge to the authorize endpoint,
 * holds onto the verifier, then sends it back at the token-exchange
 * step.
 */

export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Generate a high-entropy state nonce. Re-used for OAuth `state` and
 *  for our internal `flowId`. */
export function randomState(): string {
  return base64url(randomBytes(24));
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
