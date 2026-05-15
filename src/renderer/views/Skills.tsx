import { useEffect, useMemo, useRef, useState } from 'react';

import type { SkillSummary } from '../../shared/types';
import { MarkdownDoc } from './MarkdownText';
import { toast } from './Toaster';

interface Props {
  /** Skill to auto-select when the view mounts (deep-link from Briefings /
   * Routines). Cleared on consumption via onConsumeFocus. */
  focusedSkillId: string | null;
  onConsumeFocus: () => void;
}

/**
 * Skill manager — list + read + edit + create + delete for the
 * SKILL.md files under `~/.jarvis/skills/*`. Skills are the prompt
 * templates Routines and Briefings reference; this view is the single
 * place to see them all and tweak them without leaving the app.
 *
 * Reuses the briefings__ rail/main layout for visual consistency.
 */
export function Skills({ focusedSkillId, onConsumeFocus }: Props) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [body, setBody] = useState<string>('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void window.jarvis.listSkills().then(setSkills);
    return window.jarvis.onSkillsChanged(setSkills);
  }, []);

  // Pick a sensible default: the deep-link target, the previously
  // selected skill if still present, otherwise the first one.
  useEffect(() => {
    if (focusedSkillId && skills.some((s) => s.id === focusedSkillId)) {
      setActiveId(focusedSkillId);
      onConsumeFocus();
      return;
    }
    if (!activeId && skills.length > 0) {
      setActiveId(skills[0]!.id);
    }
    if (activeId && !skills.some((s) => s.id === activeId)) {
      setActiveId(skills[0]?.id ?? null);
    }
  }, [skills, focusedSkillId, activeId, onConsumeFocus]);

  useEffect(() => {
    if (!activeId) {
      setBody('');
      return;
    }
    void window.jarvis.readSkillBody(activeId).then(setBody);
  }, [activeId]);

  const active = useMemo(
    () => skills.find((s) => s.id === activeId) ?? null,
    [skills, activeId],
  );

  return (
    <section className="briefings">
      <aside className="briefings__rail">
        <h2 className="briefings__rail-head">SKILLS</h2>
        <p className="briefings__rail-hint">
          Prompt templates Routines and Briefings reference. Each is a
          markdown file under <code>~/.jarvis/skills/&lt;id&gt;/SKILL.md</code>{' '}
          — YAML frontmatter for tool access + the system prompt body.
        </p>
        <button
          className="briefings__generate"
          onClick={() => setCreating(true)}
          title="Create a new SKILL.md from a template"
          style={{ marginBottom: 8 }}
        >
          + New skill
        </button>
        {skills.length === 0 && (
          <div className="briefings__empty" style={{ padding: '12px 0' }}>
            No skills yet. Click <strong>+ New skill</strong> above or drop a
            file at <code>~/.jarvis/skills/&lt;id&gt;/SKILL.md</code>.
          </div>
        )}
        {skills.map((s) => (
          <button
            key={s.id}
            className={`briefings__kind${s.id === activeId ? ' briefings__kind--active' : ''}`}
            onClick={() => setActiveId(s.id)}
            title={s.path}
          >
            <div className="briefings__kind-label">{s.name}</div>
            <div className="briefings__kind-desc">
              {s.description || <em>no description</em>}
            </div>
            <div className="briefings__kind-schedule">
              {s.allowedTools.length > 0 && (
                <>
                  {s.allowedTools.length} tool
                  {s.allowedTools.length === 1 ? '' : 's'}
                </>
              )}
              {s.allowedTools.length > 0 && s.mcpServers.length > 0 && ' · '}
              {s.mcpServers.length > 0 && (
                <>
                  {s.mcpServers.length} mcp
                </>
              )}
              {s.allowedTools.length === 0 && s.mcpServers.length === 0 && (
                <em>built-in tools</em>
              )}
              {s.model && <> · {s.model}</>}
            </div>
          </button>
        ))}
      </aside>

      <main className="briefings__main">
        {!active && (
          <div className="briefings__placeholder">
            {skills.length === 0
              ? 'Create your first skill on the left.'
              : 'Pick a skill on the left.'}
          </div>
        )}
        {active && (
          <SkillDetail
            skill={active}
            body={body}
            onBodyChange={setBody}
          />
        )}
      </main>

      {creating && (
        <NewSkillDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setActiveId(id);
          }}
        />
      )}
    </section>
  );
}

/**
 * Read + edit pane for one skill. The full SKILL.md (frontmatter + body)
 * is shown as a single textarea — same shape as `briefings__content-editor`
 * but always raw text since SKILL.md is config, not prose. Frontmatter
 * validity is checked on the main process before write.
 */
function SkillDetail({
  skill,
  body,
  onBodyChange,
}: {
  skill: SkillSummary;
  body: string;
  onBodyChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(body);
  }, [body]);

  // Switching to a different skill cancels in-progress edits.
  useEffect(() => {
    setEditing(false);
  }, [skill.id]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await window.jarvis.writeSkillBody(skill.id, draft);
      if (!res.ok) {
        toast({ kind: 'error', message: res.message ?? 'Failed to save' });
        return;
      }
      onBodyChange(draft);
      setEditing(false);
      toast({ message: `Saved ${skill.name}` });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Delete skill "${skill.name}"? The folder ~/.jarvis/skills/${skill.id} will be removed.`,
      )
    )
      return;
    const res = await window.jarvis.deleteSkill(skill.id);
    if (!res.ok) {
      toast({ kind: 'error', message: res.message ?? 'Failed to delete' });
      return;
    }
    toast({ message: `Deleted ${skill.name}` });
  };

  return (
    <>
      <header className="briefings__main-head">
        <div>
          <h3 className="briefings__main-title">{skill.name}</h3>
          <div className="briefings__main-hint">
            <code>{skill.path}</code>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing ? (
            <>
              <button
                className="briefings__generate"
                onClick={() => {
                  setEditing(true);
                  setTimeout(() => textareaRef.current?.focus(), 30);
                }}
                title="Edit the SKILL.md"
              >
                ✎ Edit
              </button>
              <button
                onClick={() => void window.jarvis.revealSkill(skill.id)}
                title="Reveal in Finder"
              >
                Reveal
              </button>
              <button
                className="briefings__schedule-danger"
                onClick={() => void remove()}
                title="Delete the skill folder"
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setDraft(body);
                  setEditing(false);
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="briefings__generate"
                onClick={() => void save()}
                disabled={saving || draft === body}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="briefings__schedule">
        <div className="briefings__schedule-status">
          <span className="briefings__schedule-label">
            {skill.allowedTools.length} tools · {skill.mcpServers.length} mcp
            {skill.model ? ` · ${skill.model}` : ''}
          </span>
          {skill.description && (
            <span className="briefings__schedule-hint">{skill.description}</span>
          )}
        </div>
      </div>

      <article className="briefings__content">
        {editing ? (
          <textarea
            ref={textareaRef}
            className="briefings__content-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                void save();
              }
              if (e.key === 'Escape' && !saving) {
                setDraft(body);
                setEditing(false);
              }
            }}
          />
        ) : body ? (
          <MarkdownDoc showFrontmatter>{body}</MarkdownDoc>
        ) : (
          <div className="briefings__empty">Loading…</div>
        )}
      </article>
    </>
  );
}

/**
 * Modal for creating a new skill. Asks for name + one-line description,
 * scaffolds a SKILL.md with default frontmatter. User can edit the body
 * after creation. Slug derived from name on the main side.
 */
function NewSkillDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    try {
      const res = await window.jarvis.createSkill({
        name: name.trim(),
        description: description.trim(),
      });
      if (!res.ok || !res.id) {
        setError(res.message ?? 'Failed to create');
        return;
      }
      toast({ message: `Created skill "${name.trim()}"` });
      onCreated(res.id);
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
      <div className="project-dialog" role="dialog">
        <header className="project-dialog__head">
          <h2>New skill</h2>
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
              placeholder="weekly-retro"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <small>
              Becomes the folder name under <code>~/.jarvis/skills/</code> — slugged automatically.
            </small>
          </label>
          <label className="project-dialog__field">
            <span>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line about what this skill does"
              spellCheck={false}
            />
            <small>Shown in the palette and in Routines.</small>
          </label>
          {error && <div className="project-dialog__error">{error}</div>}
        </div>
        <footer className="project-dialog__foot">
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="project-dialog__primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create skill'}
          </button>
        </footer>
      </div>
    </div>
  );
}
