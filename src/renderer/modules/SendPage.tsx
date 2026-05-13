import { useEffect, useState } from 'react';

import type { McpServerSummary } from '../../shared/types';

/**
 * "Channels" — the page behind the Send module. Documents how to wire each
 * supported channel's MCP and shows which ones are currently connected.
 * Keeping setup as inline docs so the user doesn't have to leave Jarvis to
 * figure out how to add a new mailbox or workspace.
 */
export function SendPage() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  useEffect(() => {
    void window.jarvis.listMcpServers().then(setServers);
    return window.jarvis.onMcpServersChanged(setServers);
  }, []);
  const byId = (id: string) => servers.some((s) => s.id === id);
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

      <div className="channels">
        <ChannelCard
          name="Gmail · personal"
          status={byId('gmail-personal') ? 'connected' : 'missing'}
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
          status={byId('gmail-work') ? 'connected' : 'missing'}
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
          status={byId('slack') ? 'connected' : 'missing'}
          tool="slack"
        >
          <Steps>
            <Step>
              <strong>Create a Slack app.</strong>{' '}
              <ExtA href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</ExtA>{' '}
              → From scratch → name it (e.g. "Jarvis") → pick your workspace.
            </Step>
            <Step>
              <strong>Bot scopes.</strong> Left sidebar → <em>OAuth &
              Permissions</em> → scroll to "Bot Token Scopes" → add at least:{' '}
              <code>chat:write</code>, <code>users:read</code>,{' '}
              <code>channels:read</code>, <code>im:write</code>,{' '}
              <code>files:write</code> (for image uploads).
            </Step>
            <Step>
              <strong>Install to workspace.</strong> Top of the same page →
              "Install to Workspace" → approve. Copy the{' '}
              <code>Bot User OAuth Token</code> (<code>xoxb-…</code>).
            </Step>
            <Step>
              <strong>Find your Team ID.</strong>{' '}
              <ExtA href="https://slack.com">slack.com</ExtA> in browser →
              Workspace settings, or read it from any channel URL (the{' '}
              <code>T0XXXX</code> part).
            </Step>
            <Step>
              <strong>Wire into Jarvis.</strong> Add to{' '}
              <code>~/.jarvis/mcp.json</code>:
              <Pre>{`"slack": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-slack"],
  "env": {
    "SLACK_BOT_TOKEN": "xoxb-...",
    "SLACK_TEAM_ID": "T0XXXX..."
  }
}`}</Pre>
            </Step>
          </Steps>
        </ChannelCard>

        <ChannelCard
          name="iMessage · macOS"
          status={byId('imessage') ? 'connected' : 'optional'}
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
