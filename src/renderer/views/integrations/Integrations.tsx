import { useEffect, useMemo, useState } from 'react';

import type {
  ClaudeMcpEntry,
  McpServerSummary,
  McpToolSummary,
} from '../../../shared/types';
import { toast } from '../Toaster';
import { CATALOG, type CatalogEntry, type CatalogField } from './catalog';

type Status = 'connected' | 'claude-ai-only' | 'missing';

/**
 * The Integrations tab. Three sections:
 *   1. Catalog — curated MCPs with one-click install forms.
 *   2. Custom MCP — for arbitrary stdio servers not in the catalog.
 *   3. Installed — every server the system currently knows about,
 *      sourced from both ~/.jarvis/mcp.json and `claude mcp list`,
 *      with a "View file" affordance for the raw JSON.
 */
export function Integrations() {
  const [localServers, setLocalServers] = useState<McpServerSummary[]>([]);
  const [claudeMcps, setClaudeMcps] = useState<ClaudeMcpEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [fileContents, setFileContents] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string>('~/.jarvis/mcp.json');
  const [showFile, setShowFile] = useState(false);

  useEffect(() => {
    void window.jarvis.listMcpServers().then(setLocalServers);
    return window.jarvis.onMcpServersChanged(setLocalServers);
  }, []);

  useEffect(() => {
    const refresh = () =>
      void window.jarvis.listClaudeMcps().then(setClaudeMcps);
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, []);

  const refreshFile = async () => {
    const r = await window.jarvis.readMcpFile();
    setFilePath(r.path);
    setFileContents(r.contents);
  };
  useEffect(() => {
    void refreshFile();
  }, [localServers]);

  const localIds = useMemo(
    () => new Set(localServers.map((s) => s.id.toLowerCase())),
    [localServers],
  );
  const connectedClaudeLocal = useMemo(
    () =>
      new Set(
        claudeMcps
          .filter((m) => m.status === 'connected' && m.source !== 'claude.ai')
          .map((m) => m.name.toLowerCase()),
      ),
    [claudeMcps],
  );
  const connectedClaudeAi = useMemo(
    () =>
      new Set(
        claudeMcps
          .filter((m) => m.status === 'connected' && m.source === 'claude.ai')
          .map((m) => m.name.toLowerCase()),
      ),
    [claudeMcps],
  );

  const statusFor = (entry: CatalogEntry): Status => {
    const aliases = entry.aliases.map((a) => a.toLowerCase());
    if (aliases.some((a) => localIds.has(a))) return 'connected';
    if (aliases.some((a) => connectedClaudeLocal.has(a))) return 'connected';
    if (aliases.some((a) => connectedClaudeAi.has(a))) return 'claude-ai-only';
    return 'missing';
  };

  return (
    <section className="integrations">
      <header className="integrations__header">
        <div>
          <h2>INTEGRATIONS</h2>
          <p>
            Connect MCP servers so Jarvis tasks (and skills like{' '}
            <code>/send</code>, <code>/review-prs</code>) have access to
            external tools. Each is a one-time setup.
          </p>
        </div>
        <div className="integrations__actions">
          <button onClick={() => setShowFile((v) => !v)}>
            {showFile ? '▾ Hide JSON' : '▸ View JSON'}
          </button>
          <button onClick={() => void window.jarvis.revealMcpFile()}>
            Reveal in Finder
          </button>
        </div>
      </header>

      {showFile && (
        <pre className="integrations__file">
          <span className="integrations__file-path">{filePath}</span>
          {'\n\n'}
          {fileContents ?? '_(file not yet created — first save will write it)_'}
        </pre>
      )}

      <section>
        <h3 className="integrations__section-title">Catalog</h3>
        <div className="integrations__grid">
          {CATALOG.map((entry) => {
            const status = statusFor(entry);
            return (
              <CatalogCard
                key={entry.id}
                entry={entry}
                status={status}
                editing={editingId === entry.id}
                onEdit={() => setEditingId(entry.id)}
                onClose={() => setEditingId(null)}
                onRemove={async () => {
                  const r = await window.jarvis.removeMcpServer(entry.id);
                  if (r.ok) toast({ kind: 'info', message: `Removed ${entry.name}` });
                  else toast({ kind: 'error', message: r.message ?? 'Remove failed' });
                  await refreshFile();
                }}
              />
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="integrations__section-title">Custom MCP</h3>
        {customOpen ? (
          <CustomForm
            onClose={() => setCustomOpen(false)}
            onSaved={() => {
              setCustomOpen(false);
              toast({ message: 'Custom MCP saved' });
              void refreshFile();
            }}
          />
        ) : (
          <button
            className="integrations__custom-trigger"
            onClick={() => setCustomOpen(true)}
          >
            + Add a custom stdio MCP
          </button>
        )}
      </section>

      <section>
        <h3 className="integrations__section-title">Installed</h3>
        <InstalledList
          localServers={localServers}
          claudeMcps={claudeMcps}
          onRemoveLocal={async (id) => {
            if (!confirm(`Remove ${id} from ~/.jarvis/mcp.json?`)) return;
            const r = await window.jarvis.removeMcpServer(id);
            if (r.ok) toast({ kind: 'info', message: `Removed ${id}` });
            else toast({ kind: 'error', message: r.message ?? 'Remove failed' });
            await refreshFile();
          }}
        />
      </section>
    </section>
  );
}

interface CatalogCardProps {
  entry: CatalogEntry;
  status: Status;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onRemove: () => Promise<void>;
}

function CatalogCard({
  entry,
  status,
  editing,
  onEdit,
  onClose,
  onRemove,
}: CatalogCardProps) {
  const statusLabel =
    status === 'connected'
      ? '● connected'
      : status === 'claude-ai-only'
      ? '◐ claude.ai only'
      : '○ not set up';
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tools, setTools] = useState<McpToolSummary[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const loadTools = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const r = await window.jarvis.probeMcpTools(entry.id);
      if (r.ok && r.tools) {
        setTools(r.tools);
      } else {
        setProbeError(r.message ?? 'Probe failed');
      }
    } finally {
      setProbing(false);
    }
  };

  const toggleTools = () => {
    if (toolsOpen) {
      setToolsOpen(false);
      return;
    }
    setToolsOpen(true);
    if (!tools && !probing) void loadTools();
  };

  return (
    <article className={`bracketed integration-card integration-card--${status}`}>
      <header className="integration-card__head">
        <div>
          <h4>{entry.name}</h4>
          <p>{entry.description}</p>
        </div>
        <span className={`integration-card__status integration-card__status--${status}`}>
          {statusLabel}
        </span>
      </header>
      {editing && entry.command !== null ? (
        <CatalogForm entry={entry} onClose={onClose} onSaved={onClose} />
      ) : (
        <>
          <footer className="integration-card__actions">
            {entry.claudeAiOnly && (
              <span className="integration-card__note">
                Claude.ai-only. See setup notes.
              </span>
            )}
            {entry.command !== null && (
              <button
                className="integration-card__btn integration-card__btn--primary"
                onClick={onEdit}
              >
                {status === 'connected' ? 'Edit' : 'Configure'}
              </button>
            )}
            {status === 'connected' && entry.command !== null && (
              <button
                className="integration-card__btn"
                onClick={toggleTools}
                disabled={probing}
              >
                {probing
                  ? 'Probing…'
                  : toolsOpen
                  ? '▾ Hide tools'
                  : `▸ ${tools ? `${tools.length} tools` : 'Show tools'}`}
              </button>
            )}
            {entry.setupUrl && (
              <button
                className="integration-card__btn"
                onClick={() => void window.jarvis.openExternal(entry.setupUrl!)}
              >
                Open setup ↗
              </button>
            )}
            {status === 'connected' && entry.command !== null && (
              <button
                className="integration-card__btn integration-card__btn--danger"
                onClick={() => void onRemove()}
              >
                Remove
              </button>
            )}
          </footer>
          {toolsOpen && status === 'connected' && (
            <div className="integration-card__tools">
              {probeError && (
                <div className="integration-card__tools-error">
                  Probe failed: {probeError}
                </div>
              )}
              {tools && tools.length === 0 && !probeError && (
                <div className="integration-card__tools-empty">
                  Connected but exposed no tools.
                </div>
              )}
              {tools && tools.length > 0 && (
                <ul>
                  {tools.map((t) => (
                    <li key={t.name}>
                      <code>{t.name}</code>
                      {t.description && (
                        <span className="integration-card__tools-desc">
                          {t.description.length > 140
                            ? `${t.description.slice(0, 139)}…`
                            : t.description}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="integration-card__tools-footer">
                <button onClick={() => void loadTools()} disabled={probing}>
                  {probing ? 'Probing…' : '↻ Refresh'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </article>
  );
}

interface CatalogFormProps {
  entry: CatalogEntry;
  onClose: () => void;
  onSaved: () => void;
}

function CatalogForm({ entry, onClose, onSaved }: CatalogFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of entry.fields) init[f.key] = '';
    return init;
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const missing = entry.fields.filter((f) => f.required && !values[f.key]?.trim());
    if (missing.length) {
      toast({
        kind: 'error',
        message: `Missing: ${missing.map((f) => f.label).join(', ')}`,
      });
      return;
    }
    setSubmitting(true);
    try {
      const env: Record<string, string> = {};
      for (const f of entry.fields) {
        const v = values[f.key]?.trim();
        if (v) env[f.key] = v;
      }
      const r = await window.jarvis.addMcpServer({
        id: entry.id,
        type: 'stdio',
        command: entry.command!,
        args: entry.args,
        env,
      });
      if (!r.ok) {
        toast({ kind: 'error', message: r.message ?? 'Save failed' });
        return;
      }
      toast({ message: `${entry.name} connected` });
      onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="integration-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {entry.setupNotes && (
        <p className="integration-form__notes">{entry.setupNotes}</p>
      )}
      {entry.fields.length === 0 && (
        <p className="integration-form__notes">
          No tokens needed in Jarvis — the upstream setup handles auth.
        </p>
      )}
      {entry.fields.map((f) => (
        <FormField
          key={f.key}
          field={f}
          value={values[f.key] ?? ''}
          onChange={(v) => setValues({ ...values, [f.key]: v })}
        />
      ))}
      <footer className="integration-form__actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          className="integration-form__save"
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </form>
  );
}

function FormField({
  field,
  value,
  onChange,
}: {
  field: CatalogField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="integration-form__field">
      <span className="integration-form__label">
        {field.label}
        {field.required && <span className="integration-form__required"> *</span>}
      </span>
      <input
        type={field.kind === 'secret' ? 'password' : 'text'}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.hint && <span className="integration-form__hint">{field.hint}</span>}
    </label>
  );
}

interface CustomFormProps {
  onClose: () => void;
  onSaved: () => void;
}

function CustomForm({ onClose, onSaved }: CustomFormProps) {
  const [id, setId] = useState('');
  const [command, setCommand] = useState('npx');
  const [argsRaw, setArgsRaw] = useState('-y my-mcp-package');
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>([
    { key: '', value: '' },
  ]);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!id.trim() || !command.trim()) {
      toast({ kind: 'error', message: 'id and command are required.' });
      return;
    }
    setSubmitting(true);
    try {
      const args = argsRaw
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const env: Record<string, string> = {};
      for (const row of envRows) {
        if (row.key.trim() && row.value.trim()) env[row.key.trim()] = row.value;
      }
      const r = await window.jarvis.addMcpServer({
        id: id.trim(),
        type: 'stdio',
        command: command.trim(),
        args,
        env,
      });
      if (!r.ok) {
        toast({ kind: 'error', message: r.message ?? 'Save failed' });
        return;
      }
      onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="integration-form integration-form--custom"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="integration-form__field">
        <span className="integration-form__label">
          Server id<span className="integration-form__required"> *</span>
        </span>
        <input
          type="text"
          value={id}
          placeholder="my-server"
          onChange={(e) => setId(e.target.value)}
        />
        <span className="integration-form__hint">
          kebab-case. Becomes the tool prefix (mcp__my-server__*).
        </span>
      </label>
      <label className="integration-form__field">
        <span className="integration-form__label">
          Command<span className="integration-form__required"> *</span>
        </span>
        <input
          type="text"
          value={command}
          placeholder="npx"
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <label className="integration-form__field">
        <span className="integration-form__label">Args</span>
        <input
          type="text"
          value={argsRaw}
          placeholder="-y my-mcp-package"
          onChange={(e) => setArgsRaw(e.target.value)}
        />
        <span className="integration-form__hint">
          Space-separated. Use a wrapper script if you need shell features.
        </span>
      </label>
      <fieldset className="integration-form__env">
        <legend>Env vars</legend>
        {envRows.map((row, i) => (
          <div key={i} className="integration-form__env-row">
            <input
              type="text"
              value={row.key}
              placeholder="API_KEY"
              onChange={(e) => {
                const next = envRows.slice();
                next[i] = { ...row, key: e.target.value };
                setEnvRows(next);
              }}
            />
            <input
              type="password"
              value={row.value}
              placeholder="value"
              onChange={(e) => {
                const next = envRows.slice();
                next[i] = { ...row, value: e.target.value };
                setEnvRows(next);
              }}
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() => setEnvRows([...envRows, { key: '', value: '' }])}
        >
          + Add env var
        </button>
      </fieldset>
      <footer className="integration-form__actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="integration-form__save" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </form>
  );
}

interface InstalledListProps {
  localServers: McpServerSummary[];
  claudeMcps: ClaudeMcpEntry[];
  onRemoveLocal: (id: string) => Promise<void>;
}

function InstalledList({
  localServers,
  claudeMcps,
  onRemoveLocal,
}: InstalledListProps) {
  // Merge: a Jarvis-local server takes precedence over a same-named
  // claude entry; otherwise show both.
  const rows: Array<{
    name: string;
    sourceLabel: string;
    status: string;
    removable: boolean;
    id: string;
  }> = [];
  const localIds = new Set(localServers.map((s) => s.id));
  for (const s of localServers) {
    rows.push({
      name: s.id,
      sourceLabel: 'jarvis · ~/.jarvis/mcp.json',
      status: 'connected',
      removable: true,
      id: s.id,
    });
  }
  for (const m of claudeMcps) {
    if (localIds.has(m.name)) continue;
    rows.push({
      name: m.fullName,
      sourceLabel:
        m.source === 'claude.ai' ? 'claude.ai connector' : `claude · ${m.source}`,
      status:
        m.status === 'connected'
          ? m.source === 'claude.ai'
            ? 'claude.ai-only'
            : 'connected'
          : m.status,
      removable: false,
      id: m.name,
    });
  }
  if (rows.length === 0) {
    return <p className="integrations__empty">Nothing installed yet.</p>;
  }
  return (
    <ul className="installed-list">
      {rows.map((r) => (
        <li key={`${r.sourceLabel}-${r.id}`} className="installed-list__row">
          <div className="installed-list__main">
            <span className={`installed-list__dot installed-list__dot--${r.status}`} />
            <span className="installed-list__name">{r.name}</span>
            <span className="installed-list__source">{r.sourceLabel}</span>
          </div>
          {r.removable && (
            <button onClick={() => void onRemoveLocal(r.id)}>Remove</button>
          )}
        </li>
      ))}
    </ul>
  );
}
