import { useEffect } from 'react';

import type { Reminder, RoutineDef } from '../../shared/types';
import { KIND_LABEL, type ScheduledItem } from './scheduled-items';
import { toast } from './Toaster';

/**
 * Modal detail panel + kind-aware action buttons. Reused by both the
 * Dashboard Calendar section and the standalone Calendar module page
 * so click-on-item behaviour is identical across surfaces.
 */
export function ScheduledItemDetail({
  item,
  onClose,
}: {
  item: ScheduledItem;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta: Array<{ label: string; value: string }> = [
    { label: 'When', value: new Date(item.fireAt).toLocaleString() },
    { label: 'Type', value: KIND_LABEL[item.kind] },
  ];
  if (item.source) meta.push({ label: 'Source', value: item.source });
  if (item.url) meta.push({ label: 'URL', value: item.url });

  return (
    <div
      className="project-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="project-dialog" role="dialog">
        <header className="project-dialog__head">
          <div>
            <h2>{item.title}</h2>
            <div className="preferences-dialog__path">{KIND_LABEL[item.kind]}</div>
          </div>
          <button
            className="project-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="project-dialog__body">
          <dl className="dash-cal-detail__meta">
            {meta.map((m) => (
              <div key={m.label} className="dash-cal-detail__meta-row">
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
          {item.subtitle && (
            <p className="dash-cal-detail__body">{item.subtitle}</p>
          )}
          <ItemActions item={item} onAfter={onClose} />
        </div>
      </div>
    </div>
  );
}

function ItemActions({
  item,
  onAfter,
}: {
  item: ScheduledItem;
  onAfter: () => void;
}) {
  const buttons: Array<{ label: string; onClick: () => void; danger?: boolean }> = [];

  if (item.url) {
    buttons.push({
      label: '↗ Open URL',
      onClick: () => void window.jarvis.openExternal(item.url!),
    });
  }

  if (item.kind === 'reminder' || item.kind === 'scheduled-action') {
    const reminder = item.raw as Reminder;
    buttons.push({
      label: 'Fire now',
      onClick: async () => {
        await window.jarvis.fireReminderNow(reminder.id);
        toast({ message: 'Fired' });
        onAfter();
      },
    });
    buttons.push({
      label: 'Cancel',
      danger: true,
      onClick: async () => {
        await window.jarvis.cancelReminder(reminder.id);
        toast({ kind: 'info', message: 'Reminder cancelled' });
        onAfter();
      },
    });
  }

  if (item.kind === 'routine-next') {
    const routine = item.raw as RoutineDef;
    buttons.push({
      label: 'Run now',
      onClick: async () => {
        await window.jarvis.runRoutineNow(routine.id);
        toast({ message: `Fired · ${routine.id}` });
        onAfter();
      },
    });
    buttons.push({
      label: 'Open in Routines',
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', { detail: { tab: 'routines' } }),
        );
        onAfter();
      },
    });
  }

  if (item.kind === 'routine-last') {
    const routine = item.raw as RoutineDef;
    if (routine.lastTaskId) {
      buttons.push({
        label: '↗ View output',
        onClick: () => {
          void window.jarvis.openObservatory(routine.lastTaskId!);
          onAfter();
        },
      });
    }
    buttons.push({
      label: 'Run again',
      onClick: async () => {
        await window.jarvis.runRoutineNow(routine.id);
        toast({ message: `Fired · ${routine.id}` });
        onAfter();
      },
    });
    buttons.push({
      label: 'Open in Routines',
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', { detail: { tab: 'routines' } }),
        );
        onAfter();
      },
    });
  }

  if (item.kind === 'inbox-task' || item.kind === 'event') {
    buttons.push({
      label: 'Open Inbox',
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
        );
        onAfter();
      },
    });
  }

  if (buttons.length === 0) return null;
  return (
    <div className="dash-cal-detail__actions">
      {buttons.map((b) => (
        <button
          key={b.label}
          onClick={b.onClick}
          className={b.danger ? 'project-dialog__danger' : ''}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRel(diffMs: number): string {
  const abs = Math.abs(diffMs);
  const m = Math.round(abs / 60_000);
  const h = Math.round(m / 60);
  const d = Math.round(h / 24);
  let s: string;
  if (m < 1) s = 'now';
  else if (m < 60) s = `${m}m`;
  else if (h < 24) s = `${h}h`;
  else s = `${d}d`;
  return diffMs < 0 ? `${s} ago` : `in ${s}`;
}
