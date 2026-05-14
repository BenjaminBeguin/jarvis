import { useEffect, useRef, useState } from 'react';

import type { ProjectDef, ProjectTemplateSummary } from '../../../shared/types';
import { toast } from '../Toaster';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (def: ProjectDef) => void;
  /** Optional initial name — handy when /new-project carried a prompt body. */
  initialName?: string;
  /** When set, the dialog is in EDIT mode: pre-fills with this def's
   * fields, hides the template picker, and saves via updateProject
   * instead of createProject. */
  editing?: ProjectDef | null;
  /** Optional delete handler — only shown in edit mode. */
  onDelete?: (name: string) => void;
}

/**
 * Centered modal for adding a project to ~/.jarvis/projects.json. Used from
 * the shell scope picker, the Projects rail, and the /new-project palette
 * intent. Kept intentionally narrow — name + aliases + (optional) repo,
 * path, description. Memory is created implicitly on first append.
 */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
  initialName,
  editing,
  onDelete,
}: Props) {
  const isEdit = !!editing;
  const [name, setName] = useState(initialName ?? '');
  const [aliases, setAliases] = useState('');
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState<string>('none');
  const [templates, setTemplates] = useState<ProjectTemplateSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset + autofocus on each open. In edit mode, pre-fill from the
  // existing project; in create mode, start blank (or with initialName).
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setAliases(editing.aliases.join(', '));
      setRepo(editing.repo ?? '');
      setPath(editing.path ?? '');
      setDescription(editing.description ?? '');
    } else {
      setName(initialName ?? '');
      setAliases('');
      setRepo('');
      setPath('');
      setDescription('');
    }
    setTemplateId('none');
    setError(null);
    setBusy(false);
    if (!isEdit) {
      void window.jarvis.listProjectTemplates().then(setTemplates);
    }
    const t = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open, initialName, editing, isEdit]);

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
      const aliasList = aliases
        .split(/[,\n]/)
        .map((a) => a.trim())
        .filter(Boolean);
      const fields = {
        name: trimmed,
        aliases: aliasList,
        repo: repo.trim() || undefined,
        path: path.trim() || undefined,
        description: description.trim() || undefined,
      };
      if (isEdit && editing) {
        const def = await window.jarvis.updateProject(editing.name, fields);
        toast({ message: `Project "${def.name}" updated` });
        onCreated?.(def);
        onClose();
      } else {
        const selectedTemplate = templates.find((t) => t.id === templateId);
        const def = await window.jarvis.createProject({
          ...fields,
          templateId: templateId !== 'none' ? templateId : undefined,
        });
        const seedCount = selectedTemplate?.memorySeedCount ?? 0;
        const seedSuffix = seedCount > 0
          ? ` · seeded ${seedCount} memory file${seedCount === 1 ? '' : 's'}`
          : '';
        toast({ message: `Project "${def.name}" created${seedSuffix}` });
        onCreated?.(def);
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!editing || !onDelete) return;
    if (!confirm(`Delete project "${editing.name}"? This removes it from projects.json. The project's memory directory stays on disk.`)) {
      return;
    }
    setBusy(true);
    try {
      await window.jarvis.deleteProject(editing.name);
      onDelete(editing.name);
      toast({ message: `Project "${editing.name}" deleted` });
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
          <h2 id="project-dialog-title">
            {isEdit ? `Edit project · ${editing!.name}` : 'New project'}
          </h2>
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

          {!isEdit && templates.length > 0 && (
            <TemplatePicker
              templates={templates}
              value={templateId}
              onChange={setTemplateId}
            />
          )}

          {error && <div className="project-dialog__error">{error}</div>}
        </div>

        <footer className="project-dialog__foot">
          {isEdit && onDelete && (
            <button
              className="project-dialog__danger"
              onClick={() => void handleDelete()}
              disabled={busy}
              title="Delete this project from projects.json"
            >
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="project-dialog__primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy
              ? isEdit
                ? 'Saving…'
                : 'Creating…'
              : isEdit
                ? 'Save'
                : 'Create project'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Visual picker for the workflow template — radio cards with the template's
 * label + description and a small "seeds N memory file(s)" hint. Default is
 * the first option, which we ensure is the "none" template via
 * BUILTIN_TEMPLATES ordering in main.
 */
function TemplatePicker({
  templates,
  value,
  onChange,
}: {
  templates: ProjectTemplateSummary[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="project-dialog__field">
      <span>Workflow template</span>
      <div className="template-picker">
        {templates.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              className={`template-picker__card${active ? ' template-picker__card--active' : ''}`}
              onClick={() => onChange(t.id)}
            >
              <div className="template-picker__label">{t.label}</div>
              <div className="template-picker__desc">{t.description}</div>
              <div className="template-picker__meta">
                {t.memorySeedCount > 0
                  ? `seeds ${t.memorySeedCount} memory file${t.memorySeedCount === 1 ? '' : 's'}`
                  : 'no seeds'}
                {t.recommendedSkills && t.recommendedSkills.length > 0 && (
                  <> · {t.recommendedSkills.slice(0, 2).join(', ')}{t.recommendedSkills.length > 2 ? '…' : ''}</>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <small>Memory seeds are placeholder markdown — agents fill them in over time.</small>
    </div>
  );
}
