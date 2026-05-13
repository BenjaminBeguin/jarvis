import { useEffect, useState } from 'react';

/**
 * Tiny global toast system. Anywhere in the renderer can fire a discrete
 * confirmation with `toast({ kind, message })` — they stack bottom-right,
 * auto-fade after a few seconds, and never block input.
 *
 * Designed for the moment AFTER a save (skill accepted, reminder fired,
 * note deleted) where the user has already moved on but wants confirmation
 * that something landed. Native macOS notifications are a separate mechanism
 * (for cross-app surfacing); this is in-app only.
 */

export type ToastKind = 'success' | 'info' | 'error';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let nextId = 1;
const listeners = new Set<(t: Toast) => void>();

export function toast(input: { kind?: ToastKind; message: string }): void {
  const t: Toast = {
    id: nextId++,
    kind: input.kind ?? 'success',
    message: input.message,
  };
  for (const l of listeners) l(t);
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (t: Toast) => {
      setToasts((prev) => [...prev, t]);
      const dismissAfter = t.kind === 'error' ? 6_000 : 2_800;
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, dismissAfter);
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__dot" />
          <span className="toast__message">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
