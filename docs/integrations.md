# OAuth Integrations — setup & distribution

Jarvis's "Connect" buttons (Settings → Integrations → Connected accounts) drive an OAuth flow per provider. The Phase 1 + 2 infrastructure (orchestrator, loopback callback on `127.0.0.1:4747`, Keychain token storage, 5-min refresher) is in place. Adding a connector is a single new file under `electron/main/oauth/connectors/`.

## Who registers OAuth apps?

**You (the dev), once per provider.** End users who download Jarvis don't register anything — they click Connect, complete consent in their browser, done. The client_ids ship inside the Jarvis binary.

This is the "Jarvis-owned" model. The trade-off: your OAuth project (Google Cloud Console / Slack workspace / Notion / Linear) acquires real responsibilities the moment you distribute:

| Provider | Bundled client_id works for end users? | Real cost of distribution                                                                                       |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Google   | Yes, **with verification**             | Sensitive scopes (gmail.send, gmail.modify) hit the unverified-app warning and lock out after ~100 users. Going through Google's OAuth verification is multi-week + needs a privacy policy / homepage / domain ownership. Pre-verification: fine for solo + small beta. |
| Slack    | Only if app is "publicly distributed"  | A workspace-scoped Slack app installs only into your workspace. For other users you either submit to the Slack App Directory (approval flow), or each user creates their own Slack app and pastes credentials. Easier path for v1: keep Slack "user-supplied" — see below. |
| Notion   | Yes, with public integration approval  | Notion approves public integrations relatively quickly. Read/write to user pages is supported.                                                                              |
| Linear   | Yes                                    | OAuth apps work for everyone without extra approval. Easiest provider.                                          |

If/when distribution matters, the cleanest path is **hybrid**: ship Jarvis-owned for Notion + Linear, user-supplied for Google + Slack until verification is complete. The store + orchestrator already support this — only the UI affordance (per-connector "use my own credentials" toggle in Settings) needs to be added.

## Per-connector dev setup

### Google (Gmail + Calendar)

One OAuth client covers both APIs.

1. Open <https://console.cloud.google.com> → create or pick a project.
2. **APIs & Services → Library** → enable **Gmail API** and **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → configure (External, app name "Jarvis", support email = yours). Add the scopes:
   - `openid`, `email`, `profile`
   - `.../auth/gmail.modify`
   - `.../auth/gmail.send`
   - `.../auth/calendar`
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app**.
5. **Authorized redirect URIs** — Google's current Console hides this section for Desktop-app clients because loopback IPs (`127.0.0.1` / `localhost`) are implicitly allowed. Skip the step. If you later see `redirect_uri_mismatch` when clicking Connect, switch the client to **Application type: Web application** (same client_id; just changes the option), then under **Authorized redirect URIs → + ADD URI** paste `http://127.0.0.1:4747/oauth/callback/google` and save. (Web-application clients also require pasting the `client_secret` — see step 7.)
6. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).
7. Paste it into [electron/main/oauth/connectors/google.ts:CLIENT_ID](../electron/main/oauth/connectors/google.ts). **Web-application clients only:** also copy the **Client secret** (shown next to the client_id on the OAuth client's edit page) and paste it into the `CLIENT_SECRET` constant just below. Desktop-app clients leave it empty — PKCE alone is enough.
8. `pnpm dev` → Settings → Integrations → Connect Google.

**For solo use:** while the consent screen is in "Testing" mode, add your Google account as a Test User and grant freely. No verification needed.

**For distribution:** move the consent screen to "Production". Sensitive scopes (gmail.send, gmail.modify) trigger Google's verification queue. Plan ~2-6 weeks; you'll need a homepage URL, privacy policy URL, and proof of domain ownership.

### Slack

1. <https://api.slack.com/apps> → **Create New App → From scratch** → name + workspace.
2. **OAuth & Permissions** → **Redirect URLs** → add `http://127.0.0.1:4747/oauth/callback/slack` → Save.
3. **OAuth & Permissions** → **Scopes**:
   - **Bot Token Scopes** (the connector's defaults, 5 total): `chat:write`, `chat:write.public`, `channels:read`, `users:read`, `users:read.email`. The bot owns all reads + posting.
   - **User Token Scopes** ("send as me" + search, 2 total): `chat:write`, `search:read`. Note: `search:read` is **user-only** on Slack's API — requesting it as a bot scope makes the OAuth call fail with "Invalid permissions requested". `groups:read` (private channels) and `*:history` (`get_thread`) are intentionally NOT requested — opt in by extending `BOT_SCOPES` in [electron/main/oauth/connectors/slack.ts](../electron/main/oauth/connectors/slack.ts) and adding to your Slack app's bot scopes if you need them.
4. **Settings → Basic Information** → copy **Client ID** + **Client Secret**.
5. Paste both into the constants at the top of [electron/main/oauth/connectors/slack.ts](../electron/main/oauth/connectors/slack.ts) — `CLIENT_ID` and `CLIENT_SECRET`, replacing the `REPLACE_ME_…` placeholders.
6. (Optional) **Install to Workspace** from the App's left nav — pre-warms the OAuth grant so the consent dialog is shorter on first Connect.
7. `pnpm dev` → Settings → Integrations → Connect Slack. Pick your workspace, approve both scope sets. The new account row appears with a `send as` dropdown (`bot` / `me`) — flip it any time; the change is live on the next tool call.

**Send-as model.** The connector stores both tokens (`xoxb-…` bot + `xoxp-…` user). `chat.postMessage` reads the per-account `sendAs` preference at call time and picks the right token. Read-side tools (`search_messages`, `list_channels`, `get_thread`) always use the user token because the user has broader visibility (DMs, private channels).

**For distribution:** the workspace-scoped app only installs into yours. Two paths:
- **Slack App Directory submission** (approval flow, public listing). Reviewed manually; takes a few weeks.
- **User-supplied credentials** (recommended for v1): keep the UI affordance that lets each user paste their own client_id + secret. Their app, their workspace, no review needed.

### Notion

1. <https://www.notion.so/profile/integrations> → **+ New integration** → choose **Public integration** (so multiple workspaces can install).
2. **Capabilities** → enable read user info, read content, update content, insert content. Comments + databases as needed.
3. **OAuth Domain & URIs** → **Redirect URIs** → add `http://localhost:4747/oauth/callback/notion`. Notion is stricter than other providers about loopback: it only accepts `http://localhost` (not `http://127.0.0.1`) and rejects `https://` for non-public hosts. The connector sends this exact value; `localhost` resolves to `127.0.0.1` on macOS so the callback still lands on the Jarvis HTTP server.
4. **Secrets** → copy the **OAuth client ID** and **OAuth client secret**.
5. Paste both into [electron/main/oauth/connectors/notion.ts](../electron/main/oauth/connectors/notion.ts) — `CLIENT_ID` and `CLIENT_SECRET`, replacing the `REPLACE_ME_…` placeholders.
6. `pnpm dev` → Settings → Integrations → Connect Notion. Pick the workspace + the pages/databases the integration should see (Notion gates access per-page; grant the parents you want Jarvis to read or write).
7. For distribution: submit the integration for Notion review at the same Integrations page when you're ready to publish.

**API surface.** Per-workspace MCP entry `notion-<workspaceId>` (aliased to `notion` for the default workspace). Tools: `search`, `get_page`, `query_database`, `get_database`, `create_page`, `update_page_properties`, `append_blocks`. Notion-Version is pinned at `2022-06-28` — bump it in [electron/main/oauth/connectors/notion-mcp/index.ts](../electron/main/oauth/connectors/notion-mcp/index.ts) if you need newer endpoints.

### GitHub

GitHub has TWO auth paths — pick whichever fits.

**Personal Access Token (no app to register)**:
1. <https://github.com/settings/tokens> → Generate new token (classic or fine-grained).
2. Scopes: `repo`, `read:user`, `read:org`, `workflow`.
3. In Jarvis: Settings → Integrations → Connect GitHub → **API Key** tab → paste → Add account.

**OAuth App (for distribution to other users)**:
1. <https://github.com/settings/developers> → OAuth Apps → New OAuth App.
2. Authorization callback URL: `http://127.0.0.1:4747/oauth/callback/github`.
3. Copy **Client ID**, generate + copy **Client Secret**.
4. In Jarvis: paste both into the OAuth credentials form, then **Start OAuth flow**.

**Note: SSH keys aren't supported.** They only authenticate `git push/pull`, not GitHub's REST API. For SSH-based git operations from inside a task, the agent uses Bash + `git` directly — your existing SSH setup applies, nothing extra needed in Jarvis.

The connector publishes one stdio MCP entry per account (`github-<login>`) running `@modelcontextprotocol/server-github` with the token in env. Token is cached in main-process memory on boot (`init` lifecycle hook); never written to mcp.json.

### Linear

1. <https://linear.app/settings/api/applications> → **Create new application**.
2. **Callback URLs**: `http://127.0.0.1:4747/oauth/callback/linear`.
3. Scopes: the connector requests `read,write` by default — Linear shows what the user grants at consent time.
4. Copy the **Client ID** (Linear supports PKCE — no client secret needed for this flow).
5. Paste it into [electron/main/oauth/connectors/linear.ts](../electron/main/oauth/connectors/linear.ts) — `CLIENT_ID`, replacing the placeholder.
6. `pnpm dev` → Settings → Integrations → Connect Linear → pick the workspace → approve.

**API surface.** GraphQL only — each tool wraps a specific query / mutation. MCP entry `linear-<userId>` (aliased to `linear` for the default account). Tools: `list_teams`, `list_users`, `list_issues`, `get_issue`, `create_issue`, `update_issue`, `add_comment`.

**Tokens.** Linear's access tokens last 10 years by default, but the response includes a refresh token + expires_in. The shared refresher keeps it fresh proactively; the connector also re-checks inside a 60 s buffer at tool-call time as a belt-and-suspenders.

## Anatomy of a connector

If you ever need to add a fifth provider:

1. New file `electron/main/oauth/connectors/<name>.ts` implementing the `Connector` interface from [electron/main/oauth/types.ts](../electron/main/oauth/types.ts).
2. Register it in [electron/main/index.ts](../electron/main/index.ts) next to `googleConnector`.
3. That's it — orchestrator, loopback callback, Keychain, refresher, UI all pick it up automatically.

## Failure modes & recovery

- **`CLIENT_ID` placeholder unchanged** → `buildAuthRequest()` throws; the renderer surfaces the message in a toast pointing at the constant.
- **User revokes consent from the provider's dashboard** → refresher fails 3 times in a row, marks `needsReauth: true` on the account, UI shows "reconnect needed" label.
- **Network down at refresh time** → silent retry on next 5-min tick; only persistent failures escalate.
- **Multiple Jarvis instances on one machine** → only one binds `127.0.0.1:4747`; the other logs "HTTP API: port in use" and runs without OAuth. Quit the duplicate and reopen the one you want.
