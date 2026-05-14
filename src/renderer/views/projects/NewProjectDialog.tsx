import { useEffect, useRef, useState } from 'react';

import type { ProjectDef } from '../../../shared/types';
import { toast } from '../Toaster';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (def: ProjectDef) => void;
  /** Optional initial name — handy when /new-project carried a prompt body. */
  initialName?: string;
}

/**
 * Centered modal for adding a project to ~/.jarvis/projects.json. Used from
 * the shell scope picker, the Projects rail, and the /new-project palette
 * intent. Kept intentionally narrow — name + aliases + (optional) repo,
 * path, description. Memory is created implicitly on first append.
 */
export function NewProjectDialog({ open, onClose, onCreated, initialName }: Props) {
  const [name, setName] = useState(initialName ?? '');
  const [aliases, setAliases] = useState('');
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset + autofocus on each open.
  useEffect(() => {
    if (!open) return;
    setName(initialName ?? '');
    setAliases('');
    setRepo('');
    setPath('');
    setDescription('');
    setError(null);
    setBusy(false);
    const t = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open, initialName]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Project name is required.');
      return;
    }
    setBusy(true);
    try {
      const def = await window.jarvis.createProject({
        name: trimmed,
        aliases: aliases
          .split(/[,\n]/)
          .map((a) => a.trim())
          .filter(Boolean),
        repo: repo.trim() || undefined,
        path: path.trim() || undefined,
        description: description.trim() || undefined,
      });
      toast({ message: `Project "${def.name}" created` });
      onCreated?.(def);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="project-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="project-dialog"
        role="dialog"
        aria-labelledby="project-dialog-title"
      >
        <header className="project-dialog__head">
          <h2 id="project-dialog-title">New project</h2>
          <button
            className="project-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="project-dialog__body">
          <label className="project-dialog__field">
            <span>Name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <small>What you'll say or type. Used as the canonical label.</small>
          </label>

          <label className="project-dialog__field">
            <span>Aliases</span>
            <input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="acme, ac, work"
              spellCheck={false}
            />
            <small>
              Comma-separated. A short lowercase alias is auto-added if you
              leave this empty.
            </small>
          </label>

          <label className="project-dialog__field">
            <span>Repo</span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
              spellCheck={false}
            />
            <small>GitHub identifier so PR/review skills can find it.</small>
          </label>

          <label className="project-dialog__field">
            <span>Path</span>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/code/acme"
              spellCheck={false}
            />
            <small>Optional local checkout. Used by skills that run shell commands.</small>
          </label>

          <label className="project-dialog__field">
            <span>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short hint about what this project is"
              spellCheck={false}
            />
          </label>

          {error && <div className="project-dialog__error">{error}</div>}
        </div>

        <footer className="project-dialog__foot">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="project-dialog__primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </footer>
      </div>
    </div>
  );
}
