import { useEffect } from 'react';

import { MarkdownText } from '../MarkdownText';
// Bundled at build time via Vite's `?raw` query. The same markdown
// shipping in docs/integrations.md is the single source of truth —
// edit there and it shows up here on the next build.
//
// The `?raw` query plus a path that escapes src/ (docs/ lives at the
// repo root) defeats TS's path resolver under moduleResolution:
// Bundler, even with the wildcard `*.md?raw` declaration in
// jarvis.d.ts. Suppress at the import site — Vite resolves it fine.
// @ts-expect-error -- handled by Vite, no .d.ts for cross-dir raw imports
import docsSource from '../../../../docs/integrations.md?raw';

/**
 * Slide-in setup guide that mirrors docs/integrations.md inside the
 * app. Opens from the Integrations toolbar via the "Setup guide"
 * button. Markdown is rendered with the same component that renders
 * assistant text, so headings / links / code blocks all match.
 */
export function IntegrationsDocs({ onClose }: { onClose: () => void }) {
  // Close on Escape, same affordance as the other modals on this page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="integrations-docs__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="integrations-docs">
        <header className="integrations-docs__head">
          <div>
            <h3>Integrations · setup guide</h3>
            <span className="integrations-docs__path">docs/integrations.md</span>
          </div>
          <button
            className="integrations-docs__close"
            onClick={onClose}
            title="Close (Esc)"
          >
            ×
          </button>
        </header>
        <div className="integrations-docs__body">
          <MarkdownText>{docsSource}</MarkdownText>
        </div>
      </aside>
    </div>
  );
}
