import { useEffect, useState } from 'react';

import type { ConnectorAccount, ConnectorSummary } from '../../../shared/types';
import { toast } from '../Toaster';
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
    try {
      const init = await window.jarvis.connectIntegration(summary.id);
      if (!init.ok || !init.flowId) {
        toast({
          kind: 'error',
          message: init.message ?? `Couldn't start ${summary.name} connection`,
        });
        return;
      }
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
    }
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
            setupOpen={setupOpenId === summary.id}
            onToggleSetup={() =>
              setSetupOpenId((cur) => (cur === summary.id ? null : summary.id))
            }
            onStartConnect={async () => {
              setSetupOpenId(null);
              await handleConnect(summary);
            }}
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
  setupOpen: boolean;
  onToggleSetup: () => void;
  onStartConnect: () => void | Promise<void>;
  onDisconnect: (account: ConnectorAccount) => void;
  onSetDefault: (accountId: string) => void;
  onSetSlackSendAs: (account: ConnectorAccount, value: 'bot' | 'user') => void;
  isAccountBusy: (accountId: string) => boolean;
}

function ConnectorRow({
  summary,
  busy,
  setupOpen,
  onToggleSetup,
  onStartConnect,
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
          <strong>{summary.name}</strong>
          {!summary.builtIn && <span className="connector-row__dev">dev</span>}
          <p className="connector-row__desc">{summary.description}</p>
        </div>
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
      </header>

      {setupOpen && (
        <ConnectorSetupPanel
          setup={setup}
          providerId={summary.id}
          providerName={summary.name}
          onCancel={onToggleSetup}
          onStart={() => void onStartConnect()}
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
 * scopes, a developer-prereq warning when applicable, and the
 * Start / Cancel buttons.
 *
 * No form fields yet — every current connector does pure OAuth, so
 * there's no user-typed token to capture. The slot is reserved for
 * PAT-style connectors landing later.
 */
function ConnectorSetupPanel({
  setup,
  providerId,
  providerName,
  busy,
  onCancel,
  onStart,
}: {
  setup: ConnectorSetup | null;
  providerId: string;
  providerName: string;
  busy: boolean;
  onCancel: () => void;
  onStart: () => void;
}) {
  // Fallback when a connector hasn't been mapped in connectorSetup.ts —
  // still allow the user to start OAuth.
  if (!setup) {
    return (
      <div className="connector-setup">
        <p className="connector-setup__intro">
          {providerName} hasn't been documented here yet. Connecting opens
          the standard OAuth flow.
        </p>
        <footer className="connector-setup__actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="connector-setup__start"
            onClick={onStart}
            disabled={busy}
          >
            {busy ? 'Starting…' : 'Start OAuth flow'}
          </button>
        </footer>
      </div>
    );
  }
  return (
    <div className="connector-setup">
      <p className="connector-setup__intro">{setup.intro}</p>

      {setup.developerSetupRequired && (
        <div className="connector-setup__dev-warn">
          <strong>Developer step required.</strong>
          <p>
            This connector's OAuth client isn't registered yet. Paste
            your <code>CLIENT_ID</code> + <code>CLIENT_SECRET</code> into{' '}
            <code>{setup.developerSetupPath}</code>, restart Jarvis, then
            click Start.
          </p>
        </div>
      )}

      {setup.steps.length > 0 && (
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
                    onClick={() => void window.jarvis.openExternal(step.url!)}
                    title={step.url}
                  >
                    ↗ {step.urlLabel ?? 'Open'}
                  </button>
                )}
              </div>
              {step.body && (
                <p className="connector-setup__step-body">{step.body}</p>
              )}
              {step.command && (
                <CommandLine command={step.command} />
              )}
            </li>
          ))}
        </ol>
      )}

      {setup.scopes && setup.scopes.length > 0 && (
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
          disabled={busy}
          title={`Start OAuth for ${providerId}`}
        >
          {busy ? 'Starting…' : 'Start OAuth flow'}
        </button>
      </footer>
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
