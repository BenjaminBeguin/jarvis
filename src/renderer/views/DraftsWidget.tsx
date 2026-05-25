import { useEffect, useState } from 'react';

import type { Draft } from '../../shared/types';
import { toast } from './Toaster';

/**
 * Dashboard-friendly compact view of pending drafts. One row per
 * draft: title + the primary LLM-chosen action button. Click the
 * action to dispatch in-place. Click the row to open the full
 * Drafts view.
 *
 * Kept intentionally small — no textarea, no refine, no all-actions
 * menu. The Dashboard surface is for glance + act-on-the-obvious;
 * anything that needs editing goes to the full Drafts tab.
 */

interface Props {
  limit?: number;
}

const CHANNEL_GLYPH: Record<string, string> = {
  gmail: '✉',
  slack: '#',
  github: '◷',
  linear: 'L',
};

function navigate(tab: string): void {
  window.dispatchEvent(
    new CustomEvent('jarvis:navigate', { detail: { tab } }),
  );
}

export function DraftsWidget({ limit = 6 }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [acting, setActing] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const refresh = async () => {
      try {
        const list = await window.jarvis.listDrafts({
          status: ['pending', 'failed'],
          limit: 200,
        });
        setDrafts(list);
      } catch {
        // benign
      }
    };
    void refresh();
    const off = window.jarvis.onDraftsChanged(() => void refresh());
    return off;
  }, []);

  const visible = drafts.slice(0, limit);
  const overflow = drafts.length - visible.length;

  const runPrimary = async (draft: Draft) => {
    const primary =
      draft.actions.find((a) => a.primary) ?? draft.actions[0];
    if (!primary) return;
    setActing((s) => new Set(s).add(draft.id));
    try {
      const result = await window.jarvis.sendDraft(draft.id, primary.id);
      if (result.ok) {
        toast({ message: `${primary.label} ✓` });
      } else {
        toast({
          kind: 'error',
          message: `${primary.label} failed: ${result.message ?? 'unknown'}`,
        });
      }
    } finally {
      setActing((s) => {
        const next = new Set(s);
        next.delete(draft.id);
        return next;
      });
    }
  };

  if (drafts.length === 0) {
    return (
      <div className="drafts-widget drafts-widget--empty">
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
          Nothing waiting on you. Enable a triage workflow under Workflows ·
          Autopilot to start seeing drafts here.
        </p>
      </div>
    );
  }

  return (
    <div className="drafts-widget">
      <ul className="drafts-widget__list">
        {visible.map((d) => {
          const primary =
            d.actions.find((a) => a.primary) ?? d.actions[0];
          const glyph = CHANNEL_GLYPH[d.channel] ?? '·';
          const isActing = acting.has(d.id);
          const extraActions = d.actions.filter((a) => a !== primary).length;
          return (
            <li
              key={d.id}
              className="drafts-widget__row"
              onClick={() => navigate('drafts')}
              title="Open in Drafts"
            >
              <span
                className={`drafts-widget__chip drafts-widget__chip--${d.channel}`}
                aria-hidden
              >
                {glyph}
              </span>
              <div className="drafts-widget__text">
                <div className="drafts-widget__title">{d.title}</div>
                {d.why && (
                  <div className="drafts-widget__why">{d.why}</div>
                )}
              </div>
              {primary && (
                <button
                  type="button"
                  className="drafts-widget__action"
                  disabled={isActing}
                  onClick={(e) => {
                    e.stopPropagation();
                    void runPrimary(d);
                  }}
                  title={
                    extraActions > 0
                      ? `${primary.label} · ${extraActions} more action${extraActions === 1 ? '' : 's'} in Drafts`
                      : primary.label
                  }
                >
                  {isActing ? `${primary.label}…` : primary.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="drafts-widget__foot">
        <button
          type="button"
          className="drafts-widget__open"
          onClick={() => navigate('drafts')}
        >
          {overflow > 0
            ? `Open all ${drafts.length} drafts →`
            : 'Open Drafts →'}
        </button>
      </div>
    </div>
  );
}
