# Development

A Nuxt app that serves two surfaces from one Nitro server:

1. **Web UI** — users create *connections* and mint connector tokens for them.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector.

A connection is one of four kinds, and a connector token reaches exactly one
connection:

- **WhatsApp**, through [Evolution API](https://doc.evolution-api.com/). Paired
  by QR. Uses the Evolution server this app is configured with, or one the user
  supplies.
- **Telegram**, through the Telegram bridge in `apps/telegram-bridge`. A
  personal account linked by QR code, its chats synced into Postgres. Uses the
  bridge this app is configured with, or one the user supplies. See [Telegram connections](telegram.md).
- **PostgreSQL**, through a connection string the user supplies. Read-only
  unless a token is explicitly granted the write tool.
- **Email (IMAP)**, through a mailbox's username and app password. Read-only
  except saving drafts: headers are synced, bodies and attachments fetched from
  the mail server when asked for. See [Email (IMAP) connections](imap.md).

The app keeps its own data (users, sessions, organizations, connections and their
credentials, connector tokens) in Postgres, in an `app` schema it creates and
migrates at boot — `NUXT_DATABASE_URL` is the one thing every deployment needs.
Evolution API and its Redis are dependencies you run **only if you want WhatsApp
connections** — they sit behind a compose profile,
and `NUXT_EVOLUTION_URL` / `NUXT_EVOLUTION_ADMIN_KEY` are optional. If you do
want them, `NUXT_EVOLUTION_DATABASE_URL` is **required** — `read-messages` and
`search-messages` go through it, and the chat listing and status counts use it
when it is there. See [Reading and searching messages](whatsapp.md#reading-and-searching-messages). The Telegram bridge
is the same kind of dependency: run it **only if you want Telegram
connections**, and every `TELEGRAM_*` / `NUXT_TELEGRAM_*` variable is optional
until you do.

## Layout

```
apps/web/                    Nuxt 4 + TypeScript. Own Dockerfile, built from the repo root.
  app/pages/                 index, login, signup, verify-email, forgot-password,
                             reset-password, team, profile, billing,
                             no-organization, invite/[code], instances/{index,new,[id]}
  app/components/            app components + ui/ (shadcn-vue)
  app/composables/           session, organization, connection state, token scope,
                             table paging, API actions
  modules/                   local Nuxt modules (registers /mcp/:token)
  shared/                    types used by both the app and the server
  public/email/              the account emails' header logo
  test/                      account-email snapshots and rules (`pnpm test:emails`)
  server/api/                auth (incl. two-factor and email verification), org,
                             invites, instances, tokens, billing, hosted flag,
                             Telegram readiness, Evolution and Telegram webhooks
  server/middleware/         request body cap (00-body-limit.ts), session cookie
  server/emails/             account-email templates (HTML + plain text)
  server/mcp/index.ts        MCP handler + auth middleware
  server/mcp/tools/<group>/  one file per tool: whatsapp/, telegram/, sql/, imap/
  server/plugins/            app database, token redaction, per-kind instructions,
                             Evolution and Telegram database, cloud and email
                             verification startup checks, hosted usage rollups
  server/tasks/              scheduled: alert sweep, webhook re-registration,
                             IMAP sync, unpaired WhatsApp reaper, tool-call pruning
  server/db/migrations.ts    the app schema, applied at boot
  server/utils/              app database, auth, organizations, invitations, instances,
                             tokens, Evolution and Telegram clients and message
                             databases, mentions, alerts, mailer, outbound host
                             guard, keyed handle cache, row serialisation, SQL
                             engine seam, Postgres pool / plan guard / runner / catalog,
                             IMAP client / sync / reads, two-factor (TOTP, WebAuthn),
                             email verification, password reset, cloud client,
                             entitlements, request deadlines, body and search caps,
                             MCP client and tool-call (Telemetry) recording
apps/telegram-bridge/        Node + teleproto. Links Telegram accounts, syncs chats to Postgres.
                             Own Dockerfile, built from the repo root.
  src/                       HTTP API, sessions, locks, webhook
  src/sync/                  live updates, catch-up, backfill
apps/cloud/                  hosted offering only: plans, Stripe, outbox consumers.
                             Own Dockerfile. See docs/billing.md.
docker/aio/                  the all-in-one image: Dockerfile + s6 service tree
docker-compose.dev.yml       services only — NOT Nuxt
docker-compose.yml           the full self-hosting stack, published images
.zed/                        tasks + language server config
.env.example                 every variable, documented
```

Package manager is **pnpm** (`pnpm@11.22.0`, pinned via `packageManager`). Do not use npm/yarn.

## Local setup

```bash
cp .env.example .env          # then fill in the blanks — see comments in the file
pnpm install
pnpm services:up              # postgres only — enough for database connections
```

Nothing in `.env` has to be filled in for that to come up: the defaults for
`POSTGRES_*` and `NUXT_DATABASE_URL` agree with each other. If you want WhatsApp
connections as well:

```bash
pnpm services:up:whatsapp     # + redis, evolution
```

For Telegram connections, fill in the Telegram section of `.env` first (your own
`api_id` / `api_hash` and two generated keys — see [Telegram connections](telegram.md)), then:

```bash
pnpm services:up:telegram     # + telegram-bridge
```

Redis and Evolution sit behind a `whatsapp` compose profile because they exist
only to serve WhatsApp connections; the bridge sits behind `telegram`. Postgres
is not profiled — the app's own tables live in it. `services:down`, `:logs` and
`:ps` always pass every profile, so they cover everything either way.

The app creates its schema and applies any new migrations when it starts, so
there is no setup step for the database either.

Then start Nuxt **on the host** (it is deliberately not in compose, so you keep HMR):

```bash
pnpm dev                      # http://localhost:3000
```

Evolution (WhatsApp profile): <http://localhost:8080> · Telegram bridge (Telegram profile): <http://localhost:8095/health> · Nuxt: <http://localhost:3000>

There is no `predev` hook — bring the services up yourself.

### Scripts

| | |
|---|---|
| `pnpm dev` | Nuxt dev server on the host |
| `pnpm build` / `pnpm preview` | production build / serve it |
| `pnpm generate` | `nuxt generate` |
| `pnpm typecheck` | `nuxt typecheck` across app + server — with `bridge:typecheck`, `cloud:typecheck`, `test:emails` and `test:media`, the local checks; tests use Node's built-in runner |
| `pnpm test:emails` | the account-email templates against their snapshots in `apps/web/test/__snapshots__/emails/` (Node's built-in runner); `UPDATE_SNAPSHOTS=1` accepts a deliberate change |
| `pnpm test:media` | WhatsApp media formats, signed download links, scope/revocation/expiry checks, download failures and the 10 MiB limit (Node's built-in runner) |
| `pnpm test:oauth` | Optional OAuth configuration and guards; with `TEST_DATABASE_URL`, real PostgreSQL authorization, refresh, revocation and compatibility flows in a disposable database. See [OAuth](oauth.md). |
| `pnpm services:up` | Postgres only |
| `pnpm services:up:whatsapp` | + Evolution and Redis |
| `pnpm services:up:telegram` | + the Telegram bridge |
| `pnpm services:down` / `:logs` / `:ps` | the whole stack, profiles included |
| `pnpm bridge:dev` | the Telegram bridge on the host instead of in compose |
| `pnpm bridge:typecheck` | `tsc` for the bridge — `pnpm typecheck` does not cover it |
| `pnpm cloud:dev` | the hosted-only cloud service on the host, <http://localhost:8096> |
| `pnpm cloud:typecheck` | `tsc` for the cloud service — not covered by `pnpm typecheck` either |
| `pnpm cloud:crm-backfill` | one-off: a Brevo contact for every existing user (product list; marketing list only where consent was given at signup); needs the `BREVO_*` variables — see [billing.md](billing.md) |
| `pnpm release:version X.Y.Z` | write the release version into `package.json` and every directory listing |
| `pnpm listings:check` | refuse listings whose version or tool names disagree with the code |
| `pnpm listings:tools <server-card-url>` | regenerate `lhm.plugin.json`'s tool list from a running server's `/.well-known/mcp/server-card.json` |

The only CI is `release-check.yml`, on pull requests into `prod`: it validates
the version and builds the three images without pushing. See
[Releases](releases.md).

## Networking

Traffic crosses the host/container boundary in both directions.

| From | To | Address |
|---|---|---|
| Nuxt (host) | Evolution | `http://localhost:8080` |
| Nuxt (host) | Postgres — the app's own tables | `localhost:5432` (`NUXT_DATABASE_URL`) |
| Nuxt (host) | Postgres — Evolution's messages | `localhost:5432` (read-only sessions, see [Reading and searching messages](whatsapp.md#reading-and-searching-messages)) |
| Nuxt (host) | Telegram bridge | `http://localhost:8095` |
| Evolution (container) | Nuxt webhook | `http://host.docker.internal:3000/api/webhook/evolution` |
| Telegram bridge (container) | Nuxt webhook | `http://host.docker.internal:3000/api/webhook/telegram` |

Postgres (`5432`), Redis (`6379`), Evolution (`8080`) and the Telegram bridge
(`8095`) publish on `127.0.0.1` only: their dev credentials have defaults, and between them they hold — and can
send from — every paired account.

`host.docker.internal` is not resolvable in Linux containers by default, so the
evolution and telegram-bridge services declare
`extra_hosts: ["host.docker.internal:host-gateway"]`. The firewall rule below
covers both, since they share the compose subnet and the port.

The webhook URL each connection registers comes from `NUXT_WEBHOOK_URL`, so dev
and prod differ by configuration only — no code change. `WEBHOOK_URL` feeds only
Evolution's global webhook, which `docker-compose.dev.yml` leaves disabled.

`pnpm dev` runs `nuxt dev --host 0.0.0.0`. It has to: bound to `localhost`, Nuxt
is unreachable from the Evolution container.

Binding `0.0.0.0` means the socket listens on every interface, including your
LAN one. Whether that is actually *reachable* from the LAN depends on your
firewall — with ufw enabled and no blanket `allow 3000`, inbound LAN traffic is
still dropped and only the narrowly-scoped rule below gets through. With no
firewall, port 3000 is open to your network. Drop `--host 0.0.0.0` from
`apps/web/package.json` if you are on an untrusted network and can live without
inbound webhooks.

### Linux firewall

On a Linux host with **ufw** enabled, the webhook silently times out until you
allow it. This is not a Docker quirk — it is ordinary inbound filtering:

- The container has its own network namespace, so it reaches the host over a
  routable host IP (`host.docker.internal` → `172.17.0.1`, the `docker0`
  address), not over loopback.
- That packet arrives on a real host interface destined for a host-owned
  address, so it enters the **INPUT** chain — the same path as a packet off your
  LAN. ufw's `DEFAULT_INPUT_POLICY` is `DROP`, so it is dropped (silently, hence
  the timeout rather than a refused connection).
- The reverse direction works because published container ports are DNAT'd and
  travel the OUTPUT/FORWARD path, never INPUT. Docker writes NAT and FORWARD
  rules only — it never opens INPUT, so container → host is governed by ufw
  normally.
- `ping` from the container succeeds regardless: `/etc/ufw/before.rules` accepts
  ICMP echo ahead of the default deny. Reachable-by-ping but not by TCP is the
  signature of this problem.

The compose network's subnet is pinned to `172.31.250.0/24` so one stable rule
covers it:

```bash
sudo ufw allow from 172.31.250.0/24 to 172.17.0.1 port 3000 proto tcp comment 'evolution -> nuxt webhook'
```

Verify the round-trip:

```bash
docker compose -f docker-compose.dev.yml exec evolution \
  wget -T 5 -qO- --post-data='{"event":"ping"}' \
    --header='content-type: application/json' \
    http://host.docker.internal:3000/api/webhook/evolution
```

`{"ok":true}` means the path is open; a timeout means the rule is missing or the
subnet does not match. If you set `NUXT_WEBHOOK_SECRET`, add
`--header='x-webhook-secret: <value>'`, or the answer is a 401 (which still
proves the path is open). Everything else in the stack works without this rule —
only inbound webhooks need it.

## Auth

Two paths on the same app, deliberately kept apart. **An MCP tool never falls
back to the browser session.**

| | Web UI | MCP |
|---|---|---|
| Credential | Session cookie (`automata_session`, `httpOnly`) | `Authorization: Bearer <token>`, or `/mcp/<token>` |
| Resolved by | `server/middleware/session.ts` → `server/utils/session.ts` | `server/mcp/index.ts` → `server/utils/mcp-auth.ts` |
| Context key | `event.context.user` | `event.context.mcpAuth` |
| Backend client | `evolutionClientForInstance(instance)` / `withPg(instance, fn)` | `useEvolutionClient()` / `withPg(instance, fn)` |
| On failure | 401 JSON | **401 + `WWW-Authenticate`** — never 200 |

`server/middleware/session.ts` returns early on `/mcp`, so cookies are never even
parsed there. The cookie is 32 random bytes; `app.sessions` stores only its
SHA-256, lasts 14 days and slides forward while it is used. Passwords are scrypt
hashes (`server/utils/account.ts`); changing yours ends every other session. `useEvolutionClient()` (used by tools) reads `event.context.mcpAuth`,
has no code path to the session user, and refuses a connection that is not a
WhatsApp one.

The MCP token is minted by this app — it is **not** Evolution's `apikey`. Only its
SHA-256 hash is stored, in `app.mcp_tokens`, alongside
`last_used_at` and `expires_at`. It resolves to one row in `instances` — the
connection — which holds that connection's credentials server-side: an Evolution
token for WhatsApp, a bridge session key for Telegram, a connection string for
Postgres, a mailbox username and app password for IMAP.

**This deployment's Evolution global key never reaches a user record.** It is
used only to create and delete instances on this deployment's server
(`server/utils/instances.ts`). Every other call uses the per-instance token
Evolution issues at create time, which Evolution itself scopes to that one
instance. There is deliberately no fallback from a missing per-instance key to
the global one — that would hand any token holder access to every user's
account. A bring-your-own connection stores *its own* server's global key on its
row, hidden, for the same two operations against that server only. Neither key
is ever sent to the other's server.

A database outage answers **503**, not 401, on both surfaces — a 401 would tell
an MCP client its valid token had been revoked and invite it to throw the token
away, and sign every browser user out mid-outage.

Tokens never reach logs or error bodies: `server/plugins/redact-mcp.ts` scrubs
`/mcp/<token>` to `/mcp/[redacted]` at the source (`event.node.req.originalUrl`,
which is what Nitro's error handler reads). Route any error reporter you add
through `redactPath` / `redactHeaders` in `server/utils/redact.ts`.

Request bodies are capped before they are buffered (`server/utils/body-limit.ts`):
64 KiB for `/api`, 1 MiB for token create and scope edits, 256 KiB for webhooks,
and 2 MiB for `/mcp`, checked after the token authenticates. A new route that
needs a larger body needs its own entry there, or it answers 413.

## Adding tools

Drop a file in `apps/web/server/mcp/tools/<group>/` — it is discovered
automatically — and define it with `defineKindTool` from
`server/utils/mcp-kind-tool.ts` rather than `defineMcpTool` directly:

```ts
export default defineKindTool({
  name: 'my-tool',
  kind: 'postgres',
  title: 'Shown in client UI',
  description: 'Written for the model.',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { /* zod shape */ },
  handler: async (args) => { /* … */ },
})
```

`kind` sets the tool's `group` and its `enabled` gate, so it registers only for a
connection of that kind and only for a token whose scope allows it. Declaring the
kind once is what makes a WhatsApp tool unreachable from a Postgres token. An
optional `available()` adds a deployment-level prerequisite.

`kind` also takes an **array**, for a tool that means exactly the same thing on
more than one kind — the `sql/` set, where the engine behind the call is absorbed
by `server/utils/sql-engine.ts` and anything a model needs to know about the
difference is in that kind's `instructions`. A multi-kind tool must state its
`group` too, since there is no single kind to infer it from. Do **not** use it to
share a tool whose arguments differ: that is why Telegram has
`read-telegram-messages` rather than a second kind on `read-messages`.

Keep the basename globally unique: collisions are detected across groups, and two
tools with one name make the MCP server throw. One shared file for several kinds
satisfies that rather than straining it. `defineKindTool` adds an optional
`reason` argument to every tool — the model's one sentence on why it is calling,
recorded for Telemetry and taken off the arguments before your handler runs — so
a tool that declares its own `reason` throws at load. Give every tool an explicit
`name`, a `title` and accurate `readOnlyHint` / `destructiveHint`; see
`whatsapp/get-connection-status.ts` (read) and `sql/run-statement.ts`
(write) for the pattern. `enabled` cannot see arguments, so anything that
depends on them belongs in the handler: enforce chat scope there if the tool
touches a conversation, and run SQL through `server/utils/sql-engine.ts`, which
dispatches to the engine's runner and applies the table checks. Existing scoped
tokens will not be granted the new tool — they list the tools they were given, so
new tools are denied by default.

A new tool also has to be listed in `lhm.plugin.json`, or the release check
refuses the release: regenerate the list with
`pnpm listings:tools <url>/.well-known/mcp/server-card.json` against a running
server, and `pnpm listings:check` verifies it (see [Releases](releases.md)).

Tool handlers get the MCP SDK's `RequestHandlerExtra`, not an H3 event, so
credentials are reached through `useMcpAuth()` (the bound connection) and
`useEvolutionClient()`, both of which go through `useEvent()`; Postgres work
goes through `withPg(instance, fn)` via `server/utils/sql-engine.ts`. That is why
`nitro.experimental.asyncContext` is enabled in `nuxt.config.ts` — do not turn it off.

## Editor

`.zed/` ships tasks (`services: up`, `web: dev`, `mcp: inspector`, …) and language
server settings. Install the **Vue** extension in Zed for `vue-language-server`;
TypeScript uses the bundled `vtsls`, pointed at `apps/web/node_modules/typescript`
because pnpm does not hoist.
