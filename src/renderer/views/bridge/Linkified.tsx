import { Fragment, type ReactNode } from 'react';

/**
 * Linkified — render plain text with auto-detected references turned
 * into clickable anchors.
 *
 * Three patterns recognised:
 *   - `https?://…` URLs → link to the URL itself
 *   - `#NNNN`             → link to `contextUrl` when provided
 *                          (typical case: PR titles where item.url
 *                          points at the canonical PR page)
 *   - `ABC-123` (1–6 uppercase letters + dash + 1+ digits) → link to
 *     `contextUrl` when provided (Linear ticket, Jira issue, etc.)
 *
 * The `contextUrl` is reused for `#NNNN` and `ABC-123` because the
 * inbox source already stores the canonical destination on the item —
 * a PR row's URL IS the PR page, a Linear row's URL IS the ticket.
 * Detecting the inline pattern just lets the user click *that* part
 * of the title instead of having to find the small "Open" button.
 *
 * All anchors open via `window.jarvis.openExternal()` so the URL
 * lands in the user's default browser, not a child window of Jarvis.
 */

interface Props {
  text: string;
  /** Default destination for inline refs (#NNNN, ABC-123). Usually
   *  the parent InboxItem's `url`. */
  contextUrl?: string;
  className?: string;
}

// Combined regex: matches URLs OR `#NNNN` OR `ABC-123`. The order
// matters — URLs come first so a `#fragment` in a URL doesn't get
// split into a separate hit. The capture groups identify the kind
// so the renderer can switch behaviour.
//
// Tweaks:
//   - Linear-shaped ticket needs a word boundary on both sides so
//     it doesn't match arbitrary middle-of-word substrings.
//   - Trailing punctuation (".", ",", ")", "]") is excluded from
//     the URL match so "see https://example.com." linkifies the URL
//     and keeps the period as plain text.
const PATTERN =
  /(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`).,;:!?\]])|(\B#\d{1,8}\b)|(\b[A-Z]{1,6}-\d{1,6}\b)/g;

function openExternal(url: string): void {
  void window.jarvis.openExternal(url);
}

export function Linkified({ text, contextUrl, className }: Props) {
  if (!text) return null;
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let i = 0;
  for (const match of text.matchAll(PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      out.push(text.slice(lastIndex, start));
    }
    const [whole, url, hashRef, ticketRef] = match;
    if (url) {
      out.push(
        <a
          key={`url-${i++}`}
          href={url}
          className="bridge-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openExternal(url);
          }}
        >
          {url}
        </a>,
      );
    } else if (hashRef && contextUrl) {
      out.push(
        <a
          key={`pr-${i++}`}
          href={contextUrl}
          className="bridge-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openExternal(contextUrl);
          }}
        >
          {hashRef}
        </a>,
      );
    } else if (ticketRef && contextUrl) {
      out.push(
        <a
          key={`tk-${i++}`}
          href={contextUrl}
          className="bridge-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openExternal(contextUrl);
          }}
        >
          {ticketRef}
        </a>,
      );
    } else {
      // No contextUrl for an inline ref — render as plain text.
      out.push(whole);
    }
    lastIndex = start + whole.length;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return <span className={className}>{out.map((part, idx) => (
    typeof part === 'string' ? <Fragment key={`t-${idx}`}>{part}</Fragment> : part
  ))}</span>;
}
