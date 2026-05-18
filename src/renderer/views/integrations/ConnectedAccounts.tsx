import { useEffect, useState } from 'react';

import type { ConnectorAccount, ConnectorSummary } from '../../../shared/types';
import { toast } from '../Toaster';
import { ConnectorIcon } from './ConnectorIcon';
import { getConnectorSetup, type ConnectorSetup } from './connectorSetup';

/**
 * "Connected accounts" section of the Integrations page.
 *
 * Renders one row per registered connector. Each row shows currently-
 * connected accounts (with disconnect / default toggles), plus an "Add
 * account" button that kicks off the OAuth orchestrator → browser →
 * loopback callback round trip.
 *
 * Phase 1: only test-echo is registered, so the section shows a single
 * row that round-trips the entire pipeline without touching a real
 * provider. Phase 2+ light up Slack / Google / Notion / Linear by
 * registering them in electron/main/index.ts.
 */
export function ConnectedAccounts() {
  const [summaries, setSummaries] = useState<ConnectorSummary[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Which connector's inline setup panel is open. Open one at a time —
  // a second click on the same row closes; a click on a different row
  // swaps. Null = none open.
  const [setupOpenId, setSetupOpenId] = useState<string | null>(null);
  // In-flight OAuth flow ids by connector. Needed so the Cancel button
  // can abort the backend's pending-flow promise instead of the
  // renderer hanging until the 5-min orchestrator TTL.
  const [activeFlow, setActiveFlow] = useState<
    Record<string, string | undefined>
  >({});

  const refresh = async (): Promise<void> => {
    const next = await window.jarvis.listIntegrations();
    setSummaries(next);
  };

  useEffect(() => {
    void refresh();
    return window.jarvis.onIntegrationsChanged(() => void refresh());
  }, []);

  const setBusy = (id: string, busy: boolean): void => {
    setPending((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleConnect = async (summary: ConnectorSummary): Promise<void> => {
    setBusy(summary.id, true);
    let flowId: string | undefined;
    try {
      const init = await window.jarvis.connectIntegration(summary.id);
      if (!init.ok || !init.flowId) {
        toast({
          kind: 'error',
          message: init.message ?? `Couldn't start ${summary.name} connection`,
        });
        return;
      }
      flowId = init.flowId;
      setActiveFlow((cur) => ({ ...cur, [summary.id]: init.flowId }));
      const result = await window.jarvis.awaitIntegrationCallback(init.flowId);
      if (!result.ok) {
        toast({
          kind: 'error',
          message: result.message ?? `${summary.name} flow did not complete`,
        });
        return;
      }
      toast({
        message: `Connected ${summary.name} · ${result.account?.label ?? ''}`,
      });
    } finally {
      setBusy(summary.id, false);
      if (flowId) {
        setActiveFlow((cur) => {
          const next = { ...cur };
          delete next[summary.id];
          return next;
        });
      }
    }
  };

  const handleCancelConnect = async (
    summary: ConnectorSummary,
  ): Promise<void> => {
    const flowId = activeFlow[summary.id];
    if (!flowId) return;
    await window.jarvis.cancelIntegrationFlow(flowId);
    // The awaitIntegrationCallback promise rejects on cancellation; the
    // `finally` in handleConnect clears busy + activeFlow. No extra
    // state mutation needed here.
  };

  const handleDisconnect = async (account: ConnectorAccount): Promise<void> => {
    if (
      !confirm(
        `Disconnect ${account.label}? This drops the stored token and removes any managed MCP entry.`,
      )
    ) {
      return;
    }
    setBusy(account.id, true);
    try {
      const r = await window.jarvis.disconnectIntegration(account.id);
      if (!r.ok) {
        toast({ kind: 'error', message: r.message ?? 'Disconnect failed' });
      } else {
        toast({ kind: 'info', message: `Disconnected ${account.label}` });
      }
    } finally {
      setBusy(account.id, false);
    }
  };

  const handleSetDefault = async (
    summary: ConnectorSummary,
    accountId: string,
  ): Promise<void> => {
    const r = await window.jarvis.setIntegrationDefault(summary.id, accountId);
    if (!r.ok) {
      toast({ kind: 'error', message: r.message ?? 'Could not set default' });
    }
  };

  const handleTest = async (account: ConnectorAccount): Promise<void> => {
    setBusy(account.id, true);
    try {
      const r = await window.jarvis.testIntegrationAccount(account.id);
      if (r.ok) {
        toast({ message: `✓ ${r.summary ?? account.label}` });
      } else {
        toast({
          kind: 'error',
          message: `Test failed: ${r.message ?? 'unknown'}`,
        });
      }
    } finally {
      setBusy(account.id, false);
    }
  };

  const handleConnectByApiKey = async (
    summary: ConnectorSummary,
    apiKey: string,
  ): Promise<boolean> => {
    setBusy(summary.id, true);
    try {
      const r = await window.jarvis.connectIntegrationByApiKey(
        summary.id,
        apiKey,
      );
      if (!r.ok) {
        toast({
          kind: 'error',
          message: r.message ?? `Couldn't validate ${summary.name} key`,
        });
        return false;
      }
      toast({
        message: `Connected ${summary.name} · ${r.account?.label ?? ''}`,
      });
      return true;
    } finally {
      setBusy(summary.id, false);
    }
  };

  const handleSetSlackSendAs = async (
    account: ConnectorAccount,
    value: 'bot' | 'user',
  ): Promise<void> => {
    const r = await window.jarvis.setIntegrationAccountMeta(account.id, {
      meta: { sendAs: value },
    });
    if (!r.ok) {
      toast({
        kind: 'error',
        message: r.message ?? 'Could not change send-as preference',
      });
    } else {
      toast({
        message:
          value === 'user'
            ? `Slack messages now post as you (${account.label})`
            : `Slack messages now post as the bot (${account.label})`,
      });
    }
  };

  if (summaries.length === 0) {
    return (
      <section>
        <h3 className="integrations__section-title">Connected accounts</h3>
        <p className="integrations__empty">
          No connectors registered yet. Phase 2+ adds Slack, Google, Notion,
          Linear here.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="integrations__section-title">Connected accounts</h3>
      <div className="integrations__grid">
        {summaries.map((summary) => (
          <ConnectorRow
            key={summary.id}
            summary={summary}
            busy={pending.has(summary.id)}
            flowActive={!!activeFlow[summary.id]}
            setupOpen={setupOpenId === summary.id}
            onToggleSetup={() =>
              setSetupOpenId((cur) => (cur === summary.id ? null : summary.id))
            }
            onStartConnect={async () => {
              setSetupOpenId(null);
              await handleConnect(summary);
            }}
            onSubmitApiKey={async (apiKey) => {
              const ok = await handleConnectByApiKey(summary, apiKey);
              if (ok) setSetupOpenId(null);
              return ok;
            }}
            onCancelConnect={() => void handleCancelConnect(summary)}
            onTest={(account) => void handleTest(account)}
            onDisconnect={(account) => void handleDisconnect(account)}
            onSetDefault={(accountId) =>
              void handleSetDefault(summary, accountId)
            }
            onSetSlackSendAs={(account, value) =>
              void handleSetSlackSendAs(account, value)
            }
            isAccountBusy={(accountId) => pending.has(accountId)}
          />
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  summary: ConnectorSummary;
  busy: boolean;
  /** True when an OAuth flow is in flight for this connector (waiting
   *  for the browser callback). Shows a Cancel affordance. */
  flowActive: boolean;
  setupOpen: boolean;
  onToggleSetup: () => void;
  onStartConnect: () => void | Promise<void>;
  onSubmitApiKey: (apiKey: string) => Promise<boolean>;
  onCancelConnect: () => void;
  onTest: (account: ConnectorAccount) => void;
  onDisconnect: (account: ConnectorAccount) => void;
  onSetDefault: (accountId: string) => void;
  onSetSlackSendAs: (account: ConnectorAccount, value: 'bot' | 'user') => void;
  isAccountBusy: (accountId: string) => boolean;
}

function ConnectorRow({
  summary,
  busy,
  flowActive,
  setupOpen,
  onToggleSetup,
  onStartConnect,
  onSubmitApiKey,
  onCancelConnect,
  onTest,
  onDisconnect,
  onSetDefault,
  onSetSlackSendAs,
  isAccountBusy,
}: RowProps) {
  const hasAccounts = summary.accounts.length > 0;
  const setup = getConnectorSetup(summary.id);
  return (
    <div className="integrations__catalog-card connector-row">
      <header className="connector-row__head">
        <div>
          <ConnectorIcon id={summary.id} />
          <div className="connector-row__title-block">
            <span>
              <strong>{summary.name}</strong>
              {!summary.builtIn && (
                <span className="connector-row__dev">dev</span>
              )}
            </span>
            <p className="connector-row__desc">{summary.description}</p>
          </div>
        </div>
        {busy && flowActive ? (
          <button
            type="button"
            onClick={onCancelConnect}
            className="connector-row__connect connector-row__connect--cancel"
            title="Cancel the in-flight OAuth attempt"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onToggleSetup}
            disabled={busy}
            className={`connector-row__connect${setupOpen ? ' connector-row__connect--open' : ''}`}
            title={
              hasAccounts
                ? 'Add another account for this provider'
                : 'Connect this provider'
            }
          >
            {busy
              ? '…'
              : `${hasAccounts ? '+ Add account' : 'Connect'} ${setupOpen ? '▾' : '▸'}`}
          </button>
        )}
      </header>

      {setupOpen && (
        <ConnectorSetupPanel
          setup={setup}
          summary={summary}
          onCancel={onToggleSetup}
          onStart={() => void onStartConnect()}
          onSubmitApiKey={onSubmitApiKey}
          busy={busy}
        />
      )}

      {hasAccounts && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '12px 0 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {summary.accounts.map((account) => {
            const isDefault = summary.defaultAccountId === account.id;
            return (
              <li
                key={account.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderRadius: 4,
                  background: 'rgba(255,255,255,0.03)',
                }}
              >
                <div>
                  <span style={{ fontWeight: 500 }}>{account.label}</span>
                  {isDefault && (
                    <span
                      style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}
                    >
                      default
                    </span>
                  )}
                  {account.needsReauth && (
                    <span
                      style={{ marginLeft: 8, fontSize: 11, color: '#ff7b7b' }}
                    >
                      reconnect needed
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {summary.id === 'notion' && (
                    <button
                      type="button"
                      className="connector-row__provider-link"
                      onClick={() =>
                        void window.jarvis.openExternal(
                          'https://www.notion.so/profile/integrations',
                        )
                      }
                      title="Notion gates access per-page — open notion.so to add or remove pages this integration can see."
                    >
                      Manage pages ↗
                    </button>
                  )}
                  {summary.id === 'slack' && (
                    <label
                      style={{
                        fontSize: 12,
                        opacity: 0.7,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      send as
                      <select
                        value={
                          (account.meta as { sendAs?: string }).sendAs === 'user'
                            ? 'user'
                            : 'bot'
                        }
                        onChange={(e) =>
                          onSetSlackSendAs(
                            account,
                            e.target.value === 'user' ? 'user' : 'bot',
                          )
                        }
                        disabled={isAccountBusy(account.id)}
                      >
                        <option value="bot">bot</option>
                        <option value="user">me</option>
                      </select>
                    </label>
                  )}
                  {!isDefault && summary.accounts.length > 1 && (
                    <button
                      onClick={() => onSetDefault(account.id)}
                      disabled={isAccountBusy(account.id)}
                    >
                      Make default
                    </button>
                  )}
                  <button
                    onClick={() => onTest(account)}
                    disabled={isAccountBusy(account.id)}
                    title="Run a harmless read against this provider to confirm the token still works"
                  >
                    Test
                  </button>
                  <button
                    onClick={() => onDisconnect(account)}
                    disabled={isAccountBusy(account.id)}
                  >
                    Disconnect
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Inline panel beneath a Connect button. Renders the per-connector
 * setup steps (URLs to open, copy-able commands), the requested
 * scopes, a credentials form when the connector still needs OAuth
 * client_id / client_secret, and the Start / Cancel buttons.
 *
 * The Start button is disabled until the connector reports
 * `credentialsConfigured: true`. Saving credentials writes them to
 * Keychain (via setIntegrationCredentials); the renderer re-reads the
 * summary on the integrations-changed broadcast and the gate opens.
 */
function ConnectorSetupPanel({
  setup,
  summary,
  busy,
  onCancel,
  onStart,
  onSubmitApiKey,
}: {
  setup: ConnectorSetup | null;
  summary: ConnectorSummary;
  busy: boolean;
  onCancel: () => void;
  onStart: () => void;
  onSubmitApiKey: (apiKey: string) => Promise<boolean>;
}) {
  const providerId = summary.id;
  const providerName = summary.name;
  const needsCredentials = summary.credentialSpec.needsCredentials;
  const credentialsConfigured = summary.credentialsConfigured;
  const hasApiKeyMode = !!summary.apiKeyMode;
  const [mode, setMode] = useState<'oauth' | 'apiKey'>('oauth');
  // If the connector ONLY supports api-key, start there.
  useEffect(() => {
    if (hasApiKeyMode && !needsCredentials) setMode('apiKey');
  }, [hasApiKeyMode, needsCredentials]);

  const startDisabled =
    busy || (needsCredentials && !credentialsConfigured);
  const startTitle = startDisabled
    ? needsCredentials && !credentialsConfigured
      ? 'Save credentials first'
      : 'Starting…'
    : `Start OAuth for ${providerId}`;

  return (
    <div className="connector-setup">
      {setup?.intro && (
        <p className="connector-setup__intro">{setup.intro}</p>
      )}
      {!setup && (
        <p className="connector-setup__intro">
          {providerName} hasn't been documented here yet. Connecting opens
          the standard OAuth flow.
        </p>
      )}

      {hasApiKeyMode && (
        <div className="connector-setup__mode" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'oauth'}
            className={`connector-setup__mode-tab${mode === 'oauth' ? ' connector-setup__mode-tab--active' : ''}`}
            onClick={() => setMode('oauth')}
          >
            OAuth
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'apiKey'}
            className={`connector-setup__mode-tab${mode === 'apiKey' ? ' connector-setup__mode-tab--active' : ''}`}
            onClick={() => setMode('apiKey')}
          >
            {summary.apiKeyMode?.label ?? 'API key'}
          </button>
        </div>
      )}

      {mode === 'apiKey' && summary.apiKeyMode ? (
        <ApiKeyBlock
          summary={summary}
          busy={busy}
          onSubmit={onSubmitApiKey}
        />
      ) : (
        <>
          {needsCredentials && <CredentialsBlock summary={summary} />}

          {setup && setup.steps.length > 0 && (
            <ol className="connector-setup__steps">
              {setup.steps.map((step, i) => (
                <li key={i} className="connector-setup__step">
                  <div className="connector-setup__step-title">
                    <span className="connector-setup__step-num">{i + 1}</span>
                    <span>{step.title}</span>
                    {step.url && (
                      <button
                        type="button"
                        className="connector-setup__open"
                        onClick={() =>
                          void window.jarvis.openExternal(step.url!)
                        }
                        title={step.url}
                      >
                        ↗ {step.urlLabel ?? 'Open'}
                      </button>
                    )}
                  </div>
                  {step.body && (
                    <p className="connector-setup__step-body">{step.body}</p>
                  )}
                  {step.command && <CommandLine command={step.command} />}
                </li>
              ))}
            </ol>
          )}

          {setup && setup.scopes && setup.scopes.length > 0 && (
            <div className="connector-setup__scopes">
              <div className="connector-setup__scopes-title">
                Scopes requested
              </div>
              <ul>
                {setup.scopes.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          <footer className="connector-setup__actions">
            <button onClick={onCancel}>Cancel</button>
            <button
              className="connector-setup__start"
              onClick={onStart}
              disabled={startDisabled}
              title={startTitle}
            >
              {busy ? 'Starting…' : 'Start OAuth flow'}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}

/**
 * "Paste a personal API key" path for connectors that expose one
 * (Linear today; Notion internal-integration tokens later). The key
 * is validated server-side via the connector's `viewer`/`me` query;
 * a successful round-trip creates the account just like OAuth would.
 */
function ApiKeyBlock({
  summary,
  busy,
  onSubmit,
}: {
  summary: ConnectorSummary;
  busy: boolean;
  onSubmit: (apiKey: string) => Promise<boolean>;
}) {
  const [key, setKey] = useState('');
  const mode = summary.apiKeyMode;
  if (!mode) return null;
  const submit = async (): Promise<void> => {
    if (!key.trim()) {
      toast({ kind: 'error', message: 'API key is required' });
      return;
    }
    const ok = await onSubmit(key.trim());
    if (ok) setKey('');
  };
  return (
    <div className="connector-apikey">
      <p className="connector-apikey__help">{mode.helpText}</p>
      {mode.helpUrl && (
        <button
          type="button"
          className="connector-setup__open"
          onClick={() => void window.jarvis.openExternal(mode.helpUrl!)}
          title={mode.helpUrl}
        >
          ↗ Open {summary.name} settings
        </button>
      )}
      <label className="connector-creds__field">
        <span>{mode.label}</span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={mode.placeholder}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <footer className="connector-setup__actions">
        <button
          className="connector-setup__start"
          onClick={() => void submit()}
          disabled={busy || !key.trim()}
        >
          {busy ? 'Validating…' : 'Add account'}
        </button>
      </footer>
    </div>
  );
}

/**
 * The credentials form / saved-state block above the setup steps.
 * When the connector hasn't been configured yet, renders the client_id
 * (and optional client_secret) inputs + Save. After saving — or when
 * fallback constants in the connector source are already populated —
 * shows a "✓ Saved" pill with Replace / Clear.
 */
function CredentialsBlock({ summary }: { summary: ConnectorSummary }) {
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const secretRule = summary.credentialSpec.needsClientSecret;
  const wantsSecret = secretRule !== 'never';
  const secretRequired = secretRule === 'required';

  const handleSave = async (): Promise<void> => {
    if (!clientId.trim()) {
      toast({ kind: 'error', message: 'Client ID is required' });
      return;
    }
    if (secretRequired && !clientSecret.trim()) {
      toast({ kind: 'error', message: 'Client secret is required' });
      return;
    }
    setSaving(true);
    try {
      const r = await window.jarvis.setIntegrationCredentials(
        summary.id,
        clientId.trim(),
        wantsSecret && clientSecret.trim()
          ? clientSecret.trim()
          : undefined,
      );
      if (!r.ok) {
        toast({ kind: 'error', message: r.message ?? 'Save failed' });
        return;
      }
      toast({ message: `${summary.name} credentials saved` });
      setEditing(false);
      setClientId('');
      setClientSecret('');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async (): Promise<void> => {
    if (!confirm(`Clear ${summary.name} OAuth credentials from Keychain?`)) {
      return;
    }
    const r = await window.jarvis.clearIntegrationCredentials(summary.id);
    if (!r.ok) {
      toast({ kind: 'error', message: r.message ?? 'Clear failed' });
    } else {
      toast({ kind: 'info', message: `${summary.name} credentials cleared` });
    }
  };

  if (summary.credentialsConfigured && !editing) {
    return (
      <div className="connector-creds">
        <span className="connector-creds__ok">✓ OAuth credentials saved</span>
        <div className="connector-creds__row-actions">
          <button type="button" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button type="button" onClick={() => void handleClear()}>
            Clear
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="connector-creds connector-creds--form">
      <div className="connector-creds__title">
        OAuth credentials
        {summary.credentialsConfigured && (
          <button
            type="button"
            className="connector-creds__cancel"
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        )}
      </div>
      <label className="connector-creds__field">
        <span>Client ID</span>
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={`Paste your ${summary.name} OAuth client_id`}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {wantsSecret && (
        <label className="connector-creds__field">
          <span>
            Client Secret
            {!secretRequired && (
              <em className="connector-creds__optional"> · optional</em>
            )}
          </span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={
              secretRequired
                ? `Paste your ${summary.name} OAuth client_secret`
                : 'Leave blank for PKCE / Desktop clients'
            }
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
      <div className="connector-creds__row-actions">
        <button
          type="button"
          className="connector-creds__save"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save credentials'}
        </button>
      </div>
    </div>
  );
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <div className="connector-setup__cmd">
      <pre>{command}</pre>
      <button
        type="button"
        className="connector-setup__copy"
        onClick={() => void copy()}
      >
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  );
}
