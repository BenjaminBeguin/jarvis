import { useEffect, useMemo, useRef, useState } from 'react';

import type { Draft } from '../../shared/types';
import { toast } from './Toaster';

/**
 * Drafts — the user-facing surface for AI-generated drafts awaiting
 * review. Any triage workflow (gmail-triage today, slack-triage and
 * social later) writes here via `draft-store-write`. Each row is
 * inline-editable, can be refined via prompt ("make it shorter"),
 * and dispatched via the channel's MCP with one click.
 */

type StatusFilter = 'pending' | 'all';

const CHANNEL_BADGE: Record<string, string> = {
  gmail: 'Gmail',
  slack: 'Slack',
  github: 'GitHub',
  linear: 'Linear',
};

/** Brand-flavoured chip color (BG / FG) per channel. The values are
 *  intentionally muted so they sit alongside the surface without
 *  shouting — accent comes from the row's status border, not these. */
const CHANNEL_STYLE: Record<
  string,
  { bg: string; fg: string; glyph: string }
> = {
  gmail: { bg: 'rgba(234, 67, 53, 0.16)', fg: '#ea4335', glyph: '✉' },
  slack: { bg: 'rgba(74, 21, 75, 0.32)', fg: '#cbb1ce', glyph: '#' },
  github: { bg: 'rgba(255, 255, 255, 0.08)', fg: '#d0d0d0', glyph: '◷' },
  linear: { bg: 'rgba(94, 106, 210, 0.18)', fg: '#9aa6ff', glyph: 'L' },
};

function channelLabel(channel: string): string {
  return CHANNEL_BADGE[channel] ?? channel;
}

function channelStyle(channel: string): { bg: string; fg: string; glyph: string } {
  return (
    CHANNEL_STYLE[channel] ?? {
      bg: 'rgba(255, 255, 255, 0.08)',
      fg: 'var(--muted)',
      glyph: channel.charAt(0).toUpperCase() || '·',
    }
  );
}

function ChannelChip({ channel }: { channel: string }) {
  const style = channelStyle(channel);
  return (
    <span
      className="draft-row__channel"
      style={{ background: style.bg, color: style.fg }}
      title={channelLabel(channel)}
      aria-label={channelLabel(channel)}
    >
      {style.glyph}
    </span>
  );
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function Drafts() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /**
   * Track draft ids we've seen so newly-arrived rows can play a
   * slide-in animation exactly once. On the first render we mark
   * everything as already seen — animating rows on initial page
   * load would be noisy.
   */
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initialFetchDoneRef = useRef(false);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  const fetch = async () => {
    setRefreshing(true);
    try {
      const items = await window.jarvis.listDrafts(
        statusFilter === 'pending'
          ? { status: ['pending', 'sending', 'failed'] }
          : {},
      );
      // Diff against previously-seen ids. Only mark as "new"
      // anything that arrived AFTER the first fetch completed.
      if (initialFetchDoneRef.current) {
        const arrivedIds = items
          .map((d) => d.id)
          .filter((id) => !seenIdsRef.current.has(id));
        if (arrivedIds.length > 0) {
          setNewIds((prev) => {
            const next = new Set(prev);
            for (const id of arrivedIds) next.add(id);
            return next;
          });
          // Clear the "new" flag after the animation duration so the
          // row settles into its resting style. Matches the CSS
          // animation length below (--draft-slide-in-ms = 420ms).
          window.setTimeout(() => {
            setNewIds((prev) => {
              const next = new Set(prev);
              for (const id of arrivedIds) next.delete(id);
              return next;
            });
          }, 700);
        }
      }
      seenIdsRef.current = new Set(items.map((d) => d.id));
      initialFetchDoneRef.current = true;
      setDrafts(items);
    } catch (err) {
      console.error('[drafts] list failed', err);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    initialFetchDoneRef.current = false;
    seenIdsRef.current = new Set();
    void fetch();
    const off = window.jarvis.onDraftsChanged(() => void fetch());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const channels = useMemo(() => {
    const set = new Set<string>();
    for (const d of drafts) set.add(d.channel);
    return ['all', ...Array.from(set).sort()];
  }, [drafts]);

  const filtered = useMemo(() => {
    if (channelFilter === 'all') return drafts;
    return drafts.filter((d) => d.channel === channelFilter);
  }, [drafts, channelFilter]);

  const pendingCount = useMemo(
    () => drafts.filter((d) => d.status === 'pending').length,
    [drafts],
  );

  return (
    <div style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: '0 0 8px 0', fontSize: 20, fontWeight: 600 }}>
          Drafts
          {pendingCount > 0 && (
            <span
              style={{
                marginLeft: 12,
                padding: '2px 10px',
                borderRadius: 12,
                background: 'rgba(255, 165, 0, 0.15)',
                color: '#ffa500',
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              {pendingCount} pending
            </span>
          )}
        </h1>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
          AI drafts waiting for your review. Edit inline or refine via prompt,
          then send.
        </p>
      </header>

      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 20,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <FilterGroup label="Status">
          <FilterButton
            active={statusFilter === 'pending'}
            onClick={() => setStatusFilter('pending')}
          >
            Pending
          </FilterButton>
          <FilterButton
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          >
            All
          </FilterButton>
        </FilterGroup>
        {channels.length > 2 && (
          <FilterGroup label="Channel">
            {channels.map((c) => (
              <FilterButton
                key={c}
                active={channelFilter === c}
                onClick={() => setChannelFilter(c)}
              >
                {c === 'all' ? 'All' : channelLabel(c)}
              </FilterButton>
            ))}
          </FilterGroup>
        )}
        <button
          onClick={() => void fetch()}
          disabled={refreshing}
          style={{
            marginLeft: 'auto',
            padding: '6px 12px',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
            fontSize: 12,
            cursor: refreshing ? 'wait' : 'pointer',
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState statusFilter={statusFilter} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              expanded={expandedId === draft.id}
              isNew={newIds.has(draft.id)}
              onToggle={() =>
                setExpandedId(expandedId === draft.id ? null : draft.id)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
      {children}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        background: active ? 'var(--accent)' : 'transparent',
        border: '1px solid var(--border)',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        borderRadius: 4,
        color: active ? '#000' : 'var(--text)',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function EmptyState({ statusFilter }: { statusFilter: StatusFilter }) {
  return (
    <div
      style={{
        padding: 40,
        textAlign: 'center',
        border: '1px dashed var(--border)',
        borderRadius: 8,
        color: 'var(--muted)',
      }}
    >
      <p style={{ margin: '0 0 8px 0', fontSize: 14 }}>
        {statusFilter === 'pending'
          ? 'Nothing waiting on you.'
          : 'No drafts yet.'}
      </p>
      <p style={{ margin: 0, fontSize: 12 }}>
        Enable a triage workflow under Workflows · Autopilot. The Drafts view
        fills up when the agent has classified incoming messages.
      </p>
    </div>
  );
}

function DraftRow({
  draft,
  expanded,
  isNew,
  onToggle,
}: {
  draft: Draft;
  expanded: boolean;
  isNew: boolean;
  onToggle: () => void;
}) {
  const [body, setBody] = useState(draft.currentBody);
  const [refineOpen, setRefineOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Sync local body if the draft changes upstream (refine, revert).
  useEffect(() => {
    setBody(draft.currentBody);
  }, [draft.currentBody]);

  const dirty = body !== draft.currentBody;

  const onSave = async () => {
    if (!dirty) return;
    await window.jarvis.updateDraftBody(draft.id, body);
    toast({ message: 'Draft saved' });
  };

  const onSend = async () => {
    // Save inline edits first so the substituted body is current.
    if (dirty) {
      await window.jarvis.updateDraftBody(draft.id, body);
    }
    setSending(true);
    try {
      const result = await window.jarvis.sendDraft(draft.id);
      if (result.ok) {
        toast({ message: 'Sent ✓' });
      } else {
        toast({
          kind: 'error',
          message: `Send failed: ${result.message ?? 'unknown error'}`,
        });
      }
    } finally {
      setSending(false);
    }
  };

  const onRevert = async () => {
    await window.jarvis.revertDraft(draft.id);
    toast({ message: 'Reverted to original' });
  };

  const onDiscard = async () => {
    if (!confirm('Discard this draft? You can find it under "All" later.')) {
      return;
    }
    await window.jarvis.discardDraft(draft.id);
  };

  const statusBadge: { color: string; bg: string; label: string } = (() => {
    switch (draft.status) {
      case 'pending':
        return {
          color: '#ffa500',
          bg: 'rgba(255,165,0,0.12)',
          label: 'pending',
        };
      case 'sending':
        return {
          color: '#7aa2f7',
          bg: 'rgba(122,162,247,0.12)',
          label: 'sending…',
        };
      case 'sent':
        return {
          color: '#9ece6a',
          bg: 'rgba(158,206,106,0.12)',
          label: 'sent',
        };
      case 'failed':
        return {
          color: '#f7768e',
          bg: 'rgba(247,118,142,0.12)',
          label: 'failed',
        };
      case 'discarded':
        return {
          color: 'var(--muted)',
          bg: 'transparent',
          label: 'discarded',
        };
    }
  })();

  return (
    <article
      className={`draft-row${isNew ? ' draft-row--new' : ''}`}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface, transparent)',
      }}
    >
      <header
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          cursor: 'pointer',
        }}
        onClick={onToggle}
      >
        <ChannelChip channel={draft.channel} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              marginBottom: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {draft.title}
          </div>
          {draft.contextSummary && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {draft.contextSummary}
            </div>
          )}
          {draft.why && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginTop: 4,
                fontStyle: 'italic',
              }}
            >
              {draft.why}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              background: statusBadge.bg,
              color: statusBadge.color,
              fontSize: 10,
              fontWeight: 500,
              textTransform: 'uppercase',
            }}
          >
            {statusBadge.label}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {timeAgo(draft.updatedAt)} · via {draft.source}
          </span>
        </div>
      </header>

      {expanded && draft.intent === 'archive' && (
        <div
          style={{
            padding: '0 16px 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {draft.contextFull && (
            <details>
              <summary
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                Show original
              </summary>
              <pre
                style={{
                  margin: '8px 0 0 0',
                  padding: 12,
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: 6,
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {draft.contextFull}
              </pre>
            </details>
          )}
          <div
            style={{
              padding: 12,
              background: 'rgba(255, 165, 0, 0.04)',
              border: '1px solid rgba(255, 165, 0, 0.2)',
              borderRadius: 6,
              fontSize: 12.5,
              color: 'var(--text)',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: '#ffa500' }}>Why archive:</strong>{' '}
            {draft.why ?? 'looks like junk'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => void onSend()}
              disabled={
                sending ||
                draft.status === 'sent' ||
                draft.status === 'discarded' ||
                draft.status === 'sending'
              }
              style={{
                padding: '8px 16px',
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                opacity:
                  sending ||
                  (draft.status !== 'pending' && draft.status !== 'failed')
                    ? 0.5
                    : 1,
              }}
            >
              {sending ? 'Archiving…' : 'Archive'}
            </button>
            <button
              onClick={() => void onDiscard()}
              style={{
                marginLeft: 'auto',
                padding: '8px 16px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--muted)',
                fontSize: 13,
                cursor: 'pointer',
              }}
              title="Keep in inbox; don't archive"
            >
              Keep in inbox
            </button>
          </div>
        </div>
      )}

      {expanded && draft.intent !== 'archive' && (
        <div
          style={{
            padding: '0 16px 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {draft.contextFull && (
            <details>
              <summary
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                Show original
              </summary>
              <pre
                style={{
                  margin: '8px 0 0 0',
                  padding: 12,
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: 6,
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {draft.contextFull}
              </pre>
            </details>
          )}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => void onSave()}
            disabled={draft.status === 'sent' || draft.status === 'discarded'}
            style={{
              width: '100%',
              minHeight: 140,
              padding: 12,
              background: 'var(--input-bg, rgba(0,0,0,0.2))',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              fontSize: 13,
              fontFamily: 'inherit',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => void onSend()}
              disabled={
                sending ||
                draft.status === 'sent' ||
                draft.status === 'discarded' ||
                draft.status === 'sending'
              }
              style={{
                padding: '8px 16px',
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                opacity:
                  sending || draft.status !== 'pending' && draft.status !== 'failed'
                    ? 0.5
                    : 1,
              }}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button
              onClick={() => setRefineOpen(true)}
              disabled={draft.status === 'sent' || draft.status === 'discarded'}
              style={{
                padding: '8px 16px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Refine with prompt…
            </button>
            <button
              onClick={() => void onRevert()}
              disabled={
                draft.status === 'sent' ||
                draft.status === 'discarded' ||
                body === draft.originalBody
              }
              style={{
                padding: '8px 16px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 13,
                cursor: 'pointer',
                opacity: body === draft.originalBody ? 0.4 : 1,
              }}
            >
              Revert
            </button>
            <button
              onClick={() => void onDiscard()}
              style={{
                marginLeft: 'auto',
                padding: '8px 16px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--muted)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {refineOpen && (
        <RefineModal
          draft={draft}
          onClose={() => setRefineOpen(false)}
        />
      )}
    </article>
  );
}

function RefineModal({
  draft,
  onClose,
}: {
  draft: Draft;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.jarvis.refineDraft(draft.id, trimmed);
      if (result.ok) {
        toast({ message: 'Draft refined' });
        onClose();
      } else {
        setError(result.message ?? 'Refine failed.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refine failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '92vw',
          background: 'var(--bg, #1a1a1a)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 20,
          boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        }}
      >
        <h3
          style={{
            margin: '0 0 4px 0',
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          Refine draft
        </h3>
        <p
          style={{
            margin: '0 0 14px 0',
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          Tell the agent what to change. It reads the original message and the
          current draft.
        </p>
        <div
          style={{
            padding: 10,
            marginBottom: 12,
            background: 'rgba(0,0,0,0.25)',
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 140,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {draft.currentBody}
        </div>
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onSubmit();
            }
          }}
          placeholder="e.g. make it shorter · more formal · sound less eager"
          rows={3}
          style={{
            width: '100%',
            padding: 10,
            background: 'var(--input-bg, rgba(0,0,0,0.2))',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
            fontSize: 13,
            fontFamily: 'inherit',
            resize: 'vertical',
            boxSizing: 'border-box',
            marginBottom: 12,
          }}
        />
        {error && (
          <div
            style={{
              marginBottom: 12,
              padding: 8,
              background: 'rgba(247,118,142,0.1)',
              border: '1px solid rgba(247,118,142,0.3)',
              borderRadius: 6,
              color: '#f7768e',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => void onSubmit()}
            disabled={!prompt.trim() || loading}
            style={{
              padding: '8px 16px',
              background: 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: loading ? 'wait' : 'pointer',
              opacity: !prompt.trim() || loading ? 0.5 : 1,
            }}
          >
            {loading ? 'Refining…' : 'Refine'}
          </button>
        </div>
      </div>
    </div>
  );
}

