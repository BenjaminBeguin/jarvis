import { useEffect, useRef, useState } from 'react';

import { toast } from './Toaster';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Modal editor for `~/.jarvis/preferences.md`. The file gets prepended to
 * every task's system prompt — this is the user's "operating manual" /
 * hard rules / how-I-work. Edit freely; save writes to disk and the store
 * watcher rebroadcasts to anyone subscribed.
 */
export function PreferencesDialog({ open, onClose }: Props) {
  const [path, setPath] = useState('');
  const [draft, setDraft] = useState('');
  const [original, setOriginal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setBusy(true);
    void window.jarvis.readPreferences().then((res) => {
      if (cancelled) return;
      setPath(res.path);
      setDraft(res.contents);
      setOriginal(res.contents);
      setBusy(false);
      setTimeout(() => textareaRef.current?.focus(), 30);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Stay in sync if another process / Finder edit touches the file while
  // the dialog is open. Only refresh when the user hasn't started editing
  // — otherwise we'd clobber their in-flight draft.
  useEffect(() => {
    if (!open) return;
    return window.jarvis.onPreferencesChanged((contents: string) => {
      setOriginal(contents);
      if (draft === original) setDraft(contents);
    });
  }, [open, draft, original]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  if (!open) return null;

  const dirty = draft !== original;

  const save = async () => {
    if (!dirty) return;
    setError(null);
    setBusy(true);
    try {
      await window.jarvis.writePreferences(draft);
      setOriginal(draft);
      toast({ message: 'Preferences saved · applied to every new task' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reveal = () => {
    void window.jarvis.revealPreferences();
  };

  return (
    <div
      className="project-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          if (dirty) {
            if (!confirm('Discard unsaved changes?')) return;
          }
          onClose();
        }
      }}
    >
      <div
        className="project-dialog preferences-dialog"
        role="dialog"
        aria-labelledby="prefs-dialog-title"
      >
        <header className="project-dialog__head">
          <div>
            <h2 id="prefs-dialog-title">Preferences</h2>
            <div className="preferences-dialog__path" title={path}>
              {path || '~/.jarvis/preferences.md'}
            </div>
          </div>
          <button
            className="project-dialog__close"
            onClick={() => {
              if (dirty && !confirm('Discard unsaved changes?')) return;
              onClose();
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="project-dialog__body preferences-dialog__body">
          <p className="preferences-dialog__hint">
            Prepended to every task's system prompt as <code>## User preferences</code>.
            Edit freely. <kbd>⌘S</kbd> to save, <kbd>Esc</kbd> to close.
          </p>
          <textarea
            ref={textareaRef}
            className="preferences-dialog__textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder="# Preferences&#10;&#10;Your hard rules and how-I-work…"
          />
          {error && <div className="project-dialog__error">{error}</div>}
        </div>

        <footer className="project-dialog__foot">
          <button onClick={reveal} disabled={busy}>
            Reveal in Finder
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => {
              if (dirty && !confirm('Discard unsaved changes?')) return;
              onClose();
            }}
            disabled={busy}
          >
            {dirty ? 'Cancel' : 'Close'}
          </button>
          <button
            className="project-dialog__primary"
            onClick={() => void save()}
            disabled={busy || !dirty}
            title={dirty ? 'Save (⌘S)' : 'No changes to save'}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
