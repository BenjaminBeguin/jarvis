import { useEffect, useMemo, useState } from 'react';

import type {
  ClaudeMcpEntry,
  McpServerSummary,
  TaskSummary,
} from '../../shared/types';
import { formatRelative } from '../views/TaskList';

/**
 * "Channels" — the page behind the Send module. Documents how to wire each
 * supported channel's MCP and shows which ones are currently connected.
 * Keeping setup as inline docs so the user doesn't have to leave Jarvis to
 * figure out how to add a new mailbox or workspace.
 *
 * Connection status is the union of three sources:
 *  - ~/.jarvis/mcp.json (Jarvis-managed stdio MCPs)
 *  - `claude mcp list` (Claude-managed: claude.ai connectors + user-scoped
 *    registrations via `claude mcp add`)
 * A card is "connected" if any of those sees a matching name AND it's
 * actually working (Claude.ai connectors include a status indicator).
 */
export function SendPage() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [claudeMcps, setClaudeMcps] = useState<ClaudeMcpEntry[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  useEffect(() => {
    void window.jarvis.listMcpServers().then(setServers);
    return window.jarvis.onMcpServersChanged(setServers);
  }, []);
  useEffect(() => {
    void window.jarvis.listTasks().then(setTasks);
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === summary.id);
        if (idx === -1) return [summary, ...prev];
        const next = prev.slice();
        next[idx] = summary;
        return next;
      });
    });
    return offStatus;
  }, []);
  const sendHistory = useMemo(
    () =>
      tasks
        .filter((t) => t.skillId === 'send')
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 30),
    [tasks],
  );
  useEffect(() => {
    const refresh = () => void window.jarvis.listClaudeMcps().then(setClaudeMcps);
    refresh();
    // `claude mcp list` shells out to the CLI — modest cost — but refresh
    // periodically so a freshly-added MCP flips the badge without a page
    // reload.
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, []);
  const connectedClaude = useMemo(
    () =>
      new Set(
        claudeMcps
          .filter((m) => m.status === 'connected')
          .map((m) => m.name.toLowerCase()),
      ),
    [claudeMcps],
  );
  /**
   * A card is connected if:
   *  - There's a Jarvis local MCP with that exact id (mcp.json), OR
   *  - Claude knows about a server whose short name matches any of the
   *    accepted aliases for the card (e.g. "gmail-personal" or "Gmail").
   */
  const isConnected = (...aliases: string[]) => {
    if (aliases.some((a) => servers.some((s) => s.id === a))) return true;
    return aliases.some((a) => connectedClaude.has(a.toLowerCase()));
  };
  return (
    <div className="module-page">
      <header className="module-page__header">
        <div>
          <h2>CHANNELS</h2>
          <p>
            Use <code>/send</code> in the palette to route a message through
            any wired channel. Each card below is a separate MCP server you
            install once.
          </p>
        </div>
      </header>

      {sendHistory.length > 0 && (
        <section className="bracketed send-history">
          <header className="send-history__head">
            <h3>RECENT</h3>
            <span className="send-history__hint">click to open in observatory</span>
          </header>
          <ol className="send-history__list">
            {sendHistory.map((t) => (
              <li key={t.id}>
                <button
                  className={`send-history__row send-history__row--${historyStatus(t)}`}
                  onClick={() => void window.jarvis.openObservatory(t.id)}
                  title={new Date(t.startedAt).toLocaleString()}
                >
                  <span
                    className={`send-history__dot send-history__dot--${historyStatus(t)}`}
                  />
                  <span className="send-history__body">
                    {previewLine(t)}
                  </span>
                  <span className="send-history__meta">
                    {historyStatusLabel(t)} · {formatRelative(t.startedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="channels">
        <ChannelCard
          name="Gmail · personal"
          status={
            isConnected('gmail-personal', 'Gmail') ? 'connected' : 'missing'
          }
          tool="gmail-personal"
        >
          <Steps>
            <Step>
              <strong>One-time Google Cloud setup.</strong> Open{' '}
              <ExtA href="https://console.cloud.google.com/projectcreate">
                Cloud Console
              </ExtA>{' '}
              → create a project → enable{' '}
              <ExtA href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">
                Gmail API
              </ExtA>
              .
            </Step>
            <Step>
              <strong>OAuth client.</strong>{' '}
              <ExtA href="https://console.cloud.google.com/apis/credentials">
                APIs & Services → Credentials
              </ExtA>{' '}
              → Create credentials → <em>OAuth client ID</em> → Desktop app.
              Download the JSON.
            </Step>
            <Step>
              <strong>Consent screen.</strong>{' '}
              <ExtA href="https://console.cloud.google.com/apis/credentials/consent">
                Configure
              </ExtA>{' '}
              as External / Testing. Add your Gmail address as a Test user.
              Add scopes:{' '}
              <code>gmail.modify</code>, <code>gmail.settings.basic</code>,{' '}
              <code>gmail.send</code> (use the "add manually" textarea if the
              picker is empty).
            </Step>
            <Step>
              <strong>Mint a refresh token.</strong> Run in a terminal:
              <Pre>{`mkdir -p ~/.gmail-mcp-personal
mv ~/Downloads/client_secret_*.json ~/.gmail-mcp-personal/gcp-oauth.keys.json
cd ~/.gmail-mcp-personal
npx -y @gongrzhe/server-gmail-autoauth-mcp auth`}</Pre>
              Browser opens → log in with the personal Gmail → Advanced →
              Continue → Accept. A <code>credentials.json</code> appears in
              the folder.
            </Step>
            <Step>
              <strong>Wire into Jarvis.</strong> Add to{' '}
              <code>~/.jarvis/mcp.json</code> under <code>mcpServers</code>:
              <Pre>{`"gmail-personal": {
  "type": "stdio",
  "command": "sh",
  "args": ["-c", "cd ~/.gmail-mcp-personal && exec npx -y @gongrzhe/server-gmail-autoauth-mcp"]
}`}</Pre>
              File is watched — no restart needed.
            </Step>
          </Steps>
        </ChannelCard>

        <ChannelCard
          name="Gmail · work"
          status={isConnected('gmail-work') ? 'connected' : 'missing'}
          tool="gmail-work"
        >
          <p className="channels__hint">
            Same flow as personal, with a different folder. The same Cloud
            project + OAuth client works for both — Google links each refresh
            token to whichever address you log in with.
          </p>
          <Steps>
            <Step>
              Add the work Gmail as a Test user on the Cloud OAuth consent
              screen.
            </Step>
            <Step>
              Mint a separate token in a new folder:
              <Pre>{`mkdir -p ~/.gmail-mcp-work
cp ~/.gmail-mcp-personal/gcp-oauth.keys.json ~/.gmail-mcp-work/
cd ~/.gmail-mcp-work
npx -y @gongrzhe/server-gmail-autoauth-mcp auth`}</Pre>
              Log in with the work Gmail this time.
            </Step>
            <Step>
              Add to <code>~/.jarvis/mcp.json</code>:
              <Pre>{`"gmail-work": {
  "type": "stdio",
  "command": "sh",
  "args": ["-c", "cd ~/.gmail-mcp-work && exec npx -y @gongrzhe/server-gmail-autoauth-mcp"]
}`}</Pre>
            </Step>
          </Steps>
        </ChannelCard>

        <ChannelCard
          name="Slack"
          status={isConnected('slack', 'Slack') ? 'connected' : 'missing'}
          tool="slack"
        >
          <p className="channels__hint">
            Recommended path: use the Claude.ai Slack connector — one-click
            OAuth, no app to create, no token to manage, and messages go out
            as you (not as a bot).
          </p>
          <Steps>
            <Step>
              <strong>Open Claude's connector settings.</strong>{' '}
              <ExtA href="https://claude.ai/settings/connectors">
                claude.ai/settings/connectors
              </ExtA>{' '}
              — sign in with the same Claude account you use here.
            </Step>
            <Step>
              <strong>Connect Slack.</strong> Find <em>Slack</em> in the list
              → Connect → log in to your workspace → Allow. That's it.
            </Step>
            <Step>
              <strong>Verify from a terminal:</strong>
              <Pre>{`claude mcp list | grep Slack`}</Pre>
              You should see{' '}
              <code>claude.ai Slack: ... ✓ Connected</code>. The SDK Jarvis
              uses inherits this automatically — no <code>mcp.json</code>{' '}
              edit needed.
            </Step>
            <Step>
              <strong>Multiple workspaces?</strong> The Claude.ai connector
              ties to one workspace at a time. For a second workspace, add a
              local MCP via <code>claude mcp add</code> with a Slack bot
              token (
              <ExtA href="https://api.slack.com/apps?new_app=1">
                api.slack.com/apps
              </ExtA>
              ). Or ping me and I'll write up the bot-token path.
            </Step>
          </Steps>
        </ChannelCard>

        <ChannelCard
          name="iMessage · macOS"
          status={isConnected('imessage') ? 'connected' : 'optional'}
          tool="imessage"
        >
          <p className="channels__hint">
            macOS-only and only useful for contacts that are also on
            iMessage. Requires Full Disk Access for the MCP process so it can
            read the Messages database.
          </p>
          <Steps>
            <Step>
              Install a community iMessage MCP (search "modelcontextprotocol
              imessage" on GitHub) and follow its README.
            </Step>
            <Step>
              System Settings → Privacy & Security → Full Disk Access → add
              your terminal (or whatever runs the MCP).
            </Step>
            <Step>
              Add to <code>~/.jarvis/mcp.json</code> as <code>imessage</code>.
            </Step>
          </Steps>
        </ChannelCard>

        <ChannelCard
          name="WhatsApp"
          status="planned"
          tool="whatsapp"
        >
          <p className="channels__hint">
            No clean MCP exists for personal WhatsApp accounts. The practical
            fallbacks are: (a) route to iMessage if the contact is reachable
            there, or (b) draft-then-open the WhatsApp deep link
            (<code>https://wa.me/&lt;number&gt;?text=…</code>) so you click
            send manually. Coming as a future module.
          </p>
        </ChannelCard>
      </div>

      <footer className="channels__footer">
        <p>
          Edit <code>~/.jarvis/mcp.json</code> directly — it hot-reloads.
          See <code>~/.jarvis/mcp.json.example</code> for a starter block.
        </p>
      </footer>
    </div>
  );
}

interface ChannelCardProps {
  name: string;
  status: 'connected' | 'missing' | 'optional' | 'planned';
  tool: string;
  children: React.ReactNode;
}

function ChannelCard({ name, status, children }: ChannelCardProps) {
  const label =
    status === 'connected'
      ? 'connected'
      : status === 'missing'
      ? 'not set up'
      : status === 'optional'
      ? 'optional'
      : 'planned';
  return (
    <article className={`bracketed channel-card channel-card--${status}`}>
      <header className="channel-card__head">
        <h3>{name}</h3>
        <span className={`channel-card__status channel-card__status--${status}`}>
          {label}
        </span>
      </header>
      <div className="channel-card__body">{children}</div>
    </article>
  );
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="channels__steps">{children}</ol>;
}

function Step({ children }: { children: React.ReactNode }) {
  return <li>{children}</li>;
}

function Pre({ children }: { children: React.ReactNode }) {
  return <pre className="channels__code">{children}</pre>;
}

function historyStatus(t: TaskSummary): 'sent' | 'awaiting' | 'errored' | 'running' {
  if (t.status === 'errored' || t.status === 'aborted') return 'errored';
  if (t.awaitingInput) return 'awaiting';
  if (t.status === 'completed') return 'sent';
  return 'running';
}

function historyStatusLabel(t: TaskSummary): string {
  const s = historyStatus(t);
  if (s === 'sent') return 'sent';
  if (s === 'awaiting') return 'awaiting reply';
  if (s === 'errored') return t.status;
  return 'in progress';
}

function previewLine(t: TaskSummary): string {
  const raw = (t.inputPreview || t.title || '').trim();
  if (!raw) return 'untitled';
  return raw.length > 100 ? `${raw.slice(0, 99)}…` : raw;
}

function ExtA({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void window.jarvis.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
