import type { InboxItem } from '../../../shared/types';

/**
 * Predict what happens when the user clicks an inbox item, so the
 * Bridge can render an explicit "→ action" chip on the right edge
 * of every row. Without this, the user has no signal whether a
 * click opens a URL, launches an agent, marks something done, or
 * just jumps to the Inbox.
 *
 * Returns:
 *   - icon : single glyph for the chip
 *   - label: 1–2 word verb ("Open", "Run", "Inbox")
 *   - tone : color family (cyan / amber / magenta / slate)
 *   - tooltip: longer description for the title attribute
 *
 * MUST stay in sync with BridgePage.onAct(item) — that's the
 * function the chip is describing.
 */

export type ActionTone = 'cyan' | 'amber' | 'magenta' | 'slate';

export interface PredictedAction {
  icon: string;
  label: string;
  tone: ActionTone;
  tooltip: string;
}

export function predictAction(item: InboxItem): PredictedAction {
  const a = item.action;
  if (a?.kind === 'open-url') {
    const url = a.url ?? item.url;
    return {
      icon: '↗',
      label: 'Open',
      tone: 'cyan',
      tooltip: url ? `Open in browser — ${hostnameFor(url)}` : 'Open in browser',
    };
  }
  if (a?.kind === 'task' || (a && !a.kind)) {
    return {
      icon: '▶',
      label: a.label ?? 'Run',
      tone: 'magenta',
      tooltip: a.prompt
        ? `Launch agent — "${a.prompt.slice(0, 60)}${a.prompt.length > 60 ? '…' : ''}"`
        : 'Launch agent task',
    };
  }
  if (item.source === 'calendar' && item.url) {
    return {
      icon: '▶',
      label: 'Join',
      tone: 'amber',
      tooltip: `Join meeting — ${hostnameFor(item.url)}`,
    };
  }
  if (item.source === 'reminders') {
    if (item.url) {
      return {
        icon: '↗',
        label: 'Open',
        tone: 'cyan',
        tooltip: `Open in browser — ${hostnameFor(item.url)}`,
      };
    }
    return {
      icon: '✓',
      label: 'Done',
      tone: 'cyan',
      tooltip: 'Mark done — dismisses this reminder in place',
    };
  }
  if (item.source === 'work-awareness') {
    if (item.url) {
      return {
        icon: '↗',
        label: 'Open',
        tone: 'cyan',
        tooltip: `Open source — ${hostnameFor(item.url)}`,
      };
    }
    return {
      icon: '✓',
      label: 'Addressed',
      tone: 'cyan',
      tooltip: 'Mark addressed — dismisses this commitment in place',
    };
  }
  if (item.url) {
    return {
      icon: '↗',
      label: 'Open',
      tone: 'cyan',
      tooltip: `Open in browser — ${hostnameFor(item.url)}`,
    };
  }
  return {
    icon: '⌖',
    label: 'Inbox',
    tone: 'slate',
    tooltip: 'No direct action — jump to the Inbox to act on it',
  };
}

function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
