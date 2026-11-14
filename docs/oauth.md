# Optional MCP OAuth

OAuth lives in Automata itself. Users add `https://YOUR-AUTOMATA-HOST/mcp` in
their agent, sign in with their existing Automata account (including MFA),
choose a connector token by name, and approve. No bridge account or copied
Bearer secret is needed. The agent obtains and refreshes its own access tokens.

The consent page offers active tokens **assigned to the signed-in user**. An
admin still creates those tokens and chooses their permissions using the
existing connection page. OAuth does not mint another connector token or let a
member expand its scope. If no token is available, ask an organization admin to
issue one before starting the agent connection again.

## Enable it

OAuth is off by default. Use a build of this fork containing the module; the
upstream published image does not include it.

1. Set `NUXT_PUBLIC_APP_URL` to the public **HTTPS origin**, such as
   `https://automata.example.com`, without a subpath, query, or credentials.
2. From the repository root, generate persistent OAuth keys once into your
   gitignored `.env`. The script writes the file itself; shell redirection is
   unnecessary:

   ```bash
   node apps/web/modules/mcp-oauth/keys.mjs --append-env .env
   ```

   This appends `NUXT_MCP_OAUTH_COOKIE_KEY`, `NUXT_MCP_OAUTH_ENCRYPTION_KEY`,
   and `NUXT_MCP_OAUTH_JWKS`. Keep their values private and back them up with the
   database. For Railway or another host, copy those three values into the web
   service's environment variables. Use the JWKS JSON value without the `.env`
   file's outer single quotes in a hosting dashboard.

   Existing settings are preserved. If any OAuth key already has a value, the
   command leaves the file unchanged to avoid rotating live credentials.

   **Git Bash on Windows:** `stdout is not a tty` usually means `node` is an
   alias or wrapper using `winpty`, which rejects redirected stdout. Use the
   command above without `>> .env`, or invoke Node directly:

   ```bash
   node.exe apps/web/modules/mcp-oauth/keys.mjs --append-env .env
   ```

   Without `--append-env`, the script still prints the three assignments for
   compatibility with existing scripts.
3. Set `NUXT_MCP_OAUTH_ENABLED=true` and restart the web app. Compose forwards
   the four `NUXT_MCP_OAUTH_*` variables; the all-in-one image accepts them
   directly. HTTP loopback origins are supported only with the development
   server.
4. Check that `/.well-known/oauth-protected-resource/mcp` and
   `/.well-known/oauth-authorization-server` return JSON. An unauthenticated
   request to `/mcp` should return **401** with a `resource_metadata` challenge.

An enabled module creates its own `mcp_oauth` schema in the app database.
The database role needs permission to create it on first use, or the operator
can pre-create it owned by that role. Its migration journal is independent of
`app.migrations`. Configuration or storage failures return 503; they do not
silently permit access or masquerade as a revoked credential.

Do not generate new keys on every deployment. Changing the encryption key makes
existing OAuth records unreadable. Changing the public origin requires clients
to reconnect to the new resource. Existing Automata connector tokens continue
to use their current authentication path.

## Connect an agent

On a connection's token panel, **Connect with OAuth** shows the common `/mcp`
URL. Enter that URL in ChatGPT's custom plugin, Codex, Gemini's custom MCP app,
or Claude's custom connector and choose OAuth. The authorization opens Automata,
including the existing sign-in and MFA steps when needed. Choose your token
policy and allow access. All users use the same URL; their authorizations select
different connections and permissions.

The module provides OAuth authorization-code flow with mandatory S256 PKCE,
client metadata documents, and dynamic client registration. It supports public
clients and confidential clients using `client_secret_basic` or
`client_secret_post`. HTTPS callbacks must match their registered URI. Native
loopback callbacks support ephemeral ports through the provider's native-client
matching. Discovery, client metadata fetching, and token exchange must be
reachable from the agent's infrastructure.

ChatGPT's client metadata currently prefers `private_key_jwt` but also declares
support for public-client authentication (`none`). The module selects `none`
and requires PKCE, following [OpenAI's capability negotiation guidance](https://developers.openai.com/plugins/build/auth).
It intersects metadata grant capabilities with `authorization_code` and
`refresh_token`; other advertised grants are not enabled. Clients that require
JWT authentication without supporting `none` are rejected. Dynamic registration
still rejects unsupported grant types rather than silently changing them.

The integration suite exercises a snapshot of ChatGPT's published metadata,
Codex and Claude client metadata profiles, and Gemini dynamic registration
using mock metadata fetching and real PostgreSQL.
These protocol tests do not substitute for connecting an actual hosted client.
Before production rollout, connect each client you use, run a read-only tool,
refresh the connection, revoke it in Automata, and confirm access stops.

If authorization fails before a redirect, the error page includes the OAuth
error code and a reference matching `[mcp-oauth] OAuth request refused` in the
server logs. Use that reference to investigate, then restart the connection
from the agent after resolving the error.

## Access, expiry, and revocation

- Access tokens last one hour. Refresh tokens rotate on use; replaying an old
  refresh token revokes its grant. An authorization lasts at most 30 days.
- Each authorization binds to one connector token and its credential revision.
  Scope edits apply on the next request. Rotating or revoking the connector
  token, its expiry, removing its holder, or removing their connection access
  stops OAuth access and refreshes as well.
- **Manage connected agents**, or `/oauth/connections`, lists your live
  authorizations and lets you revoke one agent without revoking the connector
  token used by other agents. Reauthorizing creates a separate authorization.
- Existing per-token and organization rate limits, tool gates, message footers,
  limits, and optional tool-call recording apply to OAuth requests too.
- Media download links keep their existing five-minute, file-only lifetime and
  live connector-token checks. Revoking an OAuth authorization alone does not
  revoke an already-issued download link; revoking its connector token does.

To switch OAuth off, set `NUXT_MCP_OAUTH_ENABLED=false` and restart. OAuth
routes return 404, its panel is hidden, and OAuth credentials are refused. The
module does not initialize its provider or run its migrations while disabled.
Native Bearer and `/mcp/<token>` connections still work. Unexpired
authorizations can resume when re-enabled with the same origin, keys, and
database.

Keep `whatsapp-bridge` available while migrating. Its OAuth tokens belong to a
different issuer and cannot be imported: each user connects their agent once
to Automata's `/mcp` URL instead.

## Maintaining the fork

The module entry is `apps/web/modules/mcp-oauth.ts`; everything it owns is under
`apps/web/modules/mcp-oauth/`: provider configuration, encrypted PostgreSQL
adapter and migrations, HTTP and consent handlers, agent management, keys,
and the optional connection component. Nuxt discovers the local module
automatically. There is no separate OAuth process or internal HTTP proxy.

The core integration points are deliberately small:

- `server/utils/mcp-auth.ts` exports its existing hash resolver, with an option
  to validate without recording use while displaying policies. Native
  credentials and OAuth share the same live authorization, including media.
- `server/mcp/index.ts` delegates authentication to the module, which first
  tries the native resolver and falls back to OAuth only when enabled.
- Login and the global page middleware honor a strictly validated local OAuth
  return path after completing the existing sign-in flow.
- `McpTokens.vue` adds the module's optional connection panel.

During an upstream sync, keep these edits, the dependency/lockfile entries,
Compose variables, and module directory together. The module replaces only the
MCP toolkit's OAuth metadata placeholders through its Nitro registration hook;
it does not patch `node_modules`. Recheck discovery precedence and buffered
request handling when upgrading Nuxt, Nitro, the MCP toolkit, or
`oidc-provider`. Disabling OAuth requires only the environment switch, not
removing these files.

## Tests

```bash
pnpm test:oauth
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/postgres pnpm test:oauth
pnpm build
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/postgres TEST_OAUTH_BUILD=true pnpm test:oauth
```

The first command runs configuration, redirect, encryption, metadata guards,
and key-generator file handling. The integration suite runs only with `TEST_DATABASE_URL`; its role
needs `CREATEDB`. It creates a uniquely named disposable database, applies the
real app and OAuth migrations, tests HTTP flows, then drops only that database.
It never uses your app's tables as fixtures. Run `pnpm typecheck`,
`pnpm bridge:typecheck`, `pnpm cloud:typecheck`, `pnpm test:emails`,
`pnpm test:media`, and `pnpm build` as the other repository checks.

`TEST_OAUTH_BUILD=true` also boots the production output on a temporary local
port. It exercises the real `/mcp` toolkit, route precedence, login return,
and disable/re-enable restarts, then stops its server processes.
