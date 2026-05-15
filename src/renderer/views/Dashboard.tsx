import { useEffect, useMemo, useState } from 'react';

import type {
  CostSummary,
  JarvisFileEntry,
  Reminder,
  SkillSuggestion,
  TaskSummary,
} from '../../shared/types';
import { MarkdownDoc } from './MarkdownText';
import { formatRelative } from './TaskList';
import { toast } from './Toaster';
import { useNow } from './useNow';

interface Props {
  tasks: TaskSummary[];
  reminders: Reminder[];
  onSelectTask: (id: string) => void;
  onCancelReminder: (id: string) => void;
}

/**
 * "What's happening right now" command-center view. Shows live tasks,
 * sessions awaiting your reply, pending scheduled/reminders, and recent
 * meeting + note files at a glance. Click anything to drill in.
 */
export function Dashboard({ tasks, reminders, onSelectTask, onCancelReminder }: Props) {
  // 30s tick so 'in 5m' / '3 min ago' labels stay accurate.
  useNow(30_000);
  const live = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'running' && t.origin !== 'external')
        .sort((a, b) => b.startedAt - a.startedAt),
    [tasks],
  );
  const awaiting = useMemo(
    () =>
      tasks
        .filter((t) => t.awaitingInput)
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
    [tasks],
  );
  const externalLive = useMemo(
    () =>
      tasks
        .filter((t) => t.origin === 'external' && t.status === 'running' && !t.awaitingInput)
        .sort((a, b) => b.startedAt - a.startedAt),
    [tasks],
  );
  const pending = useMemo(
    () =>
      reminders
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.fireAt - b.fireAt),
    [reminders],
  );

  const [meetings, setMeetings] = useState<JarvisFileEntry[]>([]);
  const [notes, setNotes] = useState<JarvisFileEntry[]>([]);
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  interface BriefingPreview {
    kind: string;
    label: string;
    filename: string;
    title: string;
    mtimeMs: number;
  }
  const [recentBriefings, setRecentBriefings] = useState<BriefingPreview[]>([]);

  // Most-recent briefing file per kind (one per kind, newest first
  // across kinds). Refresh on briefings:changed.
  useEffect(() => {
    const refresh = async () => {
      try {
        const kinds = await window.jarvis.listBriefingKinds();
        const top: BriefingPreview[] = [];
        for (const k of kinds) {
          const files = await window.jarvis.listBriefingFiles(k.id);
          if (files.length > 0) {
            const f = files[0]!;
            top.push({
              kind: k.id,
              label: k.label,
              filename: f.filename,
              title: f.title,
              mtimeMs: f.mtimeMs,
            });
          }
        }
        top.sort((a, b) => b.mtimeMs - a.mtimeMs);
        setRecentBriefings(top);
      } catch {
        setRecentBriefings([]);
      }
    };
    void refresh();
    return window.jarvis.onBriefingsChanged(refresh);
  }, []);

  // Cost is cheap to compute (single SQLite query) but only worth
  // refreshing after a task completes / errors. Re-fetch on every change
  // to the live or awaiting lists — that's our proxy for "something
  // ended."
  useEffect(() => {
    void window.jarvis.costSummary().then(setCost).catch(() => setCost(null));
  }, [tasks.length]);

  useEffect(() => {
    void window.jarvis.listSkillSuggestions().then(setSuggestions);
    return window.jarvis.onSkillSuggestionsChanged(setSuggestions);
  }, []);

  const pendingSuggestions = useMemo(
    () => suggestions.filter((s) => s.status === 'pending'),
    [suggestions],
  );
  useEffect(() => {
    const refresh = () => {
      void window.jarvis
        .listJarvisDir('meetings')
        .then((entries) =>
          setMeetings(
            entries
              .filter((e) => !e.isDir && e.name.endsWith('.md'))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, 5),
          ),
        )
        .catch(() => setMeetings([]));
      void window.jarvis
        .listJarvisDir('notes')
        .then((entries) =>
          setNotes(
            entries
              .filter((e) => !e.isDir && e.name.endsWith('.md'))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, 5),
          ),
        )
        .catch(() => setNotes([]));
    };
    refresh();
    // Poll lightly so recent-file panels stay fresh without per-module IPC.
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="dashboard">
      <DashCard
        title="Live"
        accent="cyan"
        count={live.length}
        empty="Nothing running. ⌘⇧J to deploy."
      >
        {live.map((t) => (
          <button
            key={t.id}
            className="dashboard__row"
            onClick={() => onSelectTask(t.id)}
          >
            <span className="dashboard__row-dot dashboard__row-dot--live" />
            <span className="dashboard__row-title">{rowTitle(t)}</span>
            <span className="dashboard__row-meta">{formatRelative(t.startedAt)}</span>
          </button>
        ))}
      </DashCard>

      <DashCard
        title="Awaiting your reply"
        accent="warn"
        count={awaiting.length}
        empty="Nothing waiting on you."
      >
        {awaiting.map((t) => (
          <button
            key={t.id}
            className="dashboard__row"
            onClick={() => onSelectTask(t.id)}
          >
            <span className="dashboard__row-dot dashboard__row-dot--awaiting" />
            <span className="dashboard__row-title">{rowTitle(t)}</span>
            <span className="dashboard__row-meta">
              {formatRelative(t.endedAt ?? t.startedAt)}
            </span>
          </button>
        ))}
      </DashCard>

      <CostCard cost={cost} />

      <DashCard
        title="Latest briefings"
        accent="cyan"
        count={recentBriefings.length}
        empty="No briefings yet. Open the Briefings tab and click Generate now."
      >
        {recentBriefings.map((b) => (
          <button
            key={`${b.kind}-${b.filename}`}
            className="dashboard__row"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('jarvis:navigate', {
                  detail: { tab: 'briefings' },
                }),
              );
            }}
            title={`Open Briefings → ${b.label}`}
          >
            <span className="dashboard__row-dot" />
            <span className="dashboard__row-title">{b.label} · {b.title}</span>
            <span className="dashboard__row-meta">{formatRelative(b.mtimeMs)}</span>
          </button>
        ))}
      </DashCard>

      <DashCard
        title="Skill ideas"
        accent="cyan"
        count={pendingSuggestions.length}
        empty="Type /suggest-skills to scan your prompts for reusable patterns."
      >
        {pendingSuggestions.map((s) => {
          const expanded = expandedId === s.id;
          return (
            <div key={s.id} className="dashboard__suggestion">
              <div className="dashboard__suggestion-head">
                <span className="dashboard__suggestion-name">{s.name}</span>
                {s.frequency > 1 && (
                  <span className="dashboard__suggestion-freq">×{s.frequency}</span>
                )}
                <div className="dashboard__suggestion-actions">
                  <button
                    title="Preview SKILL.md"
                    onClick={() => setExpandedId(expanded ? null : s.id)}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                  <button
                    title="Accept — write to ~/.jarvis/skills"
                    onClick={async () => {
                      const r = await window.jarvis.acceptSkillSuggestion(s.id);
                      if (!r.ok) {
                        toast({ kind: 'error', message: r.message ?? 'Could not accept.' });
                      } else {
                        toast({ message: `Skill saved · ${s.name}` });
                      }
                    }}
                  >
                    ✓
                  </button>
                  <button
                    title="Dismiss"
                    onClick={() => {
                      void window.jarvis.dismissSkillSuggestion(s.id);
                      toast({ kind: 'info', message: 'Suggestion dismissed' });
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="dashboard__suggestion-desc">{s.description}</div>
              {expanded && (
                <div className="dashboard__suggestion-body">
                  <MarkdownDoc showFrontmatter>{s.body}</MarkdownDoc>
                </div>
              )}
            </div>
          );
        })}
      </DashCard>

      <DashCard
        title="Scheduled"
        accent="warn"
        count={pending.length}
        empty="No scheduled actions or reminders."
      >
        {pending.map((r) => (
          <div key={r.id} className="dashboard__row dashboard__row--reminder">
            <span className="dashboard__row-glyph">
              {r.mode === 'scheduled' ? '⚡' : '⏰'}
            </span>
            <span className="dashboard__row-title">
              {r.body.length > 60 ? `${r.body.slice(0, 59)}…` : r.body}
            </span>
            <span className="dashboard__row-meta">{formatRelative(r.fireAt)}</span>
            <button
              className="dashboard__row-cancel"
              title="Cancel"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Cancel: "${r.body}"?`)) onCancelReminder(r.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </DashCard>

      <DashCard
        title="Other agents"
        accent="good"
        count={externalLive.length}
        empty="No external Claude sessions running."
      >
        {externalLive.map((t) => (
          <button
            key={t.id}
            className="dashboard__row"
            onClick={() => onSelectTask(t.id)}
          >
            <span className="dashboard__row-dot dashboard__row-dot--agent" />
            <span className="dashboard__row-title">{rowTitle(t)}</span>
            <span className="dashboard__row-meta">{formatRelative(t.startedAt)}</span>
          </button>
        ))}
      </DashCard>

      <DashCard
        title="Recent meetings"
        accent="dim"
        count={meetings.length}
        empty="No meetings yet."
      >
        {meetings.map((m) => (
          <div key={m.name} className="dashboard__row dashboard__row--file">
            <span className="dashboard__row-glyph">🎙</span>
            <span className="dashboard__row-title">{m.name.replace(/\.md$/, '')}</span>
            <span className="dashboard__row-meta">{formatRelative(m.mtimeMs)}</span>
          </div>
        ))}
      </DashCard>

      <DashCard
        title="Recent notes"
        accent="dim"
        count={notes.length}
        empty="No notes yet. /note in the palette."
      >
        {notes.map((n) => (
          <div key={n.name} className="dashboard__row dashboard__row--file">
            <span className="dashboard__row-glyph">✎</span>
            <span className="dashboard__row-title">{n.name.replace(/\.md$/, '')}</span>
            <span className="dashboard__row-meta">{formatRelative(n.mtimeMs)}</span>
          </div>
        ))}
      </DashCard>
    </div>
  );
}

function rowTitle(t: TaskSummary): string {
  const head = t.title || t.inputPreview || 'untitled';
  return head.length > 80 ? `${head.slice(0, 79)}…` : head;
}

interface CardProps {
  title: string;
  accent: 'cyan' | 'warn' | 'good' | 'dim';
  count: number;
  empty: string;
  children: React.ReactNode;
}

function DashCard({ title, accent, count, empty, children }: CardProps) {
  const arr = Array.isArray(children) ? children : [children];
  const hasContent = arr.some(Boolean);
  return (
    <section className={`dashboard__card dashboard__card--${accent}`}>
      <header className="dashboard__card-head">
        <span className="dashboard__card-title">{title}</span>
        <span className="dashboard__card-count">{count}</span>
      </header>
      <div className="dashboard__card-body">
        {hasContent ? children : <div className="dashboard__empty">{empty}</div>}
      </div>
    </section>
  );
}

/**
 * Cost rollup card. Three big numbers (today / 7d / month) + top 3 skills
 * by 30-day spend so the user can spot which skill is eating the budget.
 * Excludes external Claude Code mirror sessions (Jarvis didn't pay).
 */
function CostCard({ cost }: { cost: CostSummary | null }) {
  return (
    <section className="dashboard__card dashboard__card--dim">
      <header className="dashboard__card-head">
        <span className="dashboard__card-title">Cost</span>
        <span className="dashboard__card-count">
          {cost ? fmtUsd(cost.thisMonth) : '—'}
        </span>
      </header>
      <div className="dashboard__card-body">
        {cost ? (
          <>
            <div className="dashboard__cost-row">
              <span className="dashboard__cost-label">Today</span>
              <span className="dashboard__cost-value">{fmtUsd(cost.today)}</span>
            </div>
            <div className="dashboard__cost-row">
              <span className="dashboard__cost-label">7 days</span>
              <span className="dashboard__cost-value">{fmtUsd(cost.last7days)}</span>
            </div>
            <div className="dashboard__cost-row">
              <span className="dashboard__cost-label">This month</span>
              <span className="dashboard__cost-value">{fmtUsd(cost.thisMonth)}</span>
            </div>
            {cost.topSkills.length > 0 && (
              <div className="dashboard__cost-skills">
                <div className="dashboard__cost-skills-head">Top skills · 30d</div>
                {cost.topSkills.map((s) => (
                  <div
                    key={s.skillId ?? '__free'}
                    className="dashboard__cost-skill"
                  >
                    <span className="dashboard__cost-skill-name">
                      {s.skillId ?? 'free-text'}
                    </span>
                    <span className="dashboard__cost-skill-meta">
                      {fmtUsd(s.totalUsd)} · {s.taskCount} run
                      {s.taskCount === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="dashboard__empty">No spend yet.</div>
        )}
      </div>
    </section>
  );
}

function fmtUsd(n: number): string {
  if (n < 0.01) return n === 0 ? '$0.00' : '<$0.01';
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
