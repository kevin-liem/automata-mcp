# Self-hosting

Two ways to run the whole app from published images:

- **[Single container](#single-container)** — one `docker run`. Postgres,
  Redis, Evolution API, the web app and the Telegram bridge share one image and
  one volume; every secret is generated on first boot.
- **[Docker Compose](#docker-compose)** — `docker-compose.yml` at the repository
  root, one container per service, WhatsApp and Telegram behind profiles.

Neither is the development setup; for that, see [Development](development.md).

## Single container

```bash
docker run -d --name automata --restart unless-stopped --stop-timeout 30 \
  -p 3000:3000 -v automata_data:/data \
  -e NUXT_PUBLIC_APP_URL=https://automata.example.com \
  ghcr.io/ju-li/automata-mcp-aio:1
```

Open the app on port 3000 and sign up. The first account creates an
organization and is its admin. First boot creates the database and runs
Evolution's and the app's migrations; `docker logs -f automata` shows each
service starting.

`NUXT_PUBLIC_APP_URL` is the address people will open — every connector URL is
built from it. Left out, it defaults to `http://localhost:3000`, which is fine
for trying it and wrong for anything Claude has to reach.

`--stop-timeout 30` gives the services time to stop in order — the web app,
Evolution and the bridge first, Postgres last. Docker's default 10 seconds can
cut that short.

### What is inside

| Process | Version | Listens on (inside the container) |
|---|---|---|
| Web app | this release | `3000`, or `$PORT` — the only port to publish |
| Postgres | 16 (Alpine's `postgresql16`) | loopback, port `5432` |
| Redis | 8.2.9 | `127.0.0.1:6379` |
| Evolution API | v2.3.7 | `18080` |
| Telegram bridge | this release | `18095` |

The image is built on Evolution's own image, so Evolution runs exactly as it
ships; [s6-overlay](https://github.com/just-containers/s6-overlay) starts the
rest in order, restarts what crashes and stops the container if a start-up step
fails. The image is large (about 2 GB), most of it Evolution's.

`PORT` may not be one of the internal ports above; the container refuses to
start and says so.

### Everything lives in `/data`

| Path | Holds |
|---|---|
| `/data/postgres` | the database: every user, connection, stored credential and synced message |
| `/data/redis` | Evolution's cache |
| `/data/evolution` | Evolution's session files |
| `/data/secrets` | the generated secrets, one file each |

**Back up the whole volume.** On first boot the container generates
`POSTGRES_PASSWORD`, `WEBHOOK_SECRET`, `EVOLUTION_API_KEY`,
`TELEGRAM_BRIDGE_ADMIN_KEY` and `TELEGRAM_SESSION_ENCRYPTION_KEY` into
`/data/secrets`. Losing `TELEGRAM_SESSION_ENCRYPTION_KEY` unlinks every Telegram
account; losing the volume loses everything, and every WhatsApp number needs its
QR scanned again.

An environment variable with one of those names overrides the stored file
(which is left as it was). Set them only if you manage secrets elsewhere, keep
them URL-safe (`openssl rand -hex 32`), and never change
`TELEGRAM_SESSION_ENCRYPTION_KEY` after the first boot.

`docker rm` and `docker run` again with the same volume is safe — that is also
how to update. **`docker volume rm automata_data` is the single-container
`docker compose down -v`**: see the warnings below.

### Options

Everything is optional. The names are the ones `.env.selfhost.example` uses, so
a filled-in copy works as `docker run --env-file .env …`; blank values are
ignored. `PORT` is the one extra; it has no line there.

| Variable | For |
|---|---|
| `NUXT_PUBLIC_APP_URL` | the public address (above) |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Telegram — from <https://my.telegram.org>, both or neither. Without them the app tells an admin what to set. See [Telegram connections](telegram.md). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_TLS`, `MAIL_FROM`, `MAIL_FROM_NAME` | [connection alerts](alerts.md), invitation, email-verification and password-reset emails. Without `SMTP_HOST`, verification is off (unless `EMAIL_VERIFICATION=required`) and passwords cannot be reset from the app |
| `OPS_ALERT_EMAIL` | where reconnect loops and stuck sessions on this container's Evolution are reported — see [Telling the operator about a reconnect loop or a stuck session](alerts.md#telling-the-operator-about-a-reconnect-loop-or-a-stuck-session); needs SMTP |
| `ALLOW_PRIVATE_TARGETS` | `true` lets connections reach private and loopback addresses — see below |
| `SIGNUP`, `SIGNUP_CODE` | who can create an account — see [Who can sign up](#who-can-sign-up) |
| `EMAIL_VERIFICATION` | `auto` / `required` / `off` — see [Email verification](#email-verification) |
| `MCP_RATE_TOKEN_PER_MINUTE`, `MCP_RATE_ORG_PER_MINUTE`, `MCP_RATE_EXPENSIVE_PER_MINUTE`, `REDIS_URL` | [MCP rate limits](#mcp-rate-limits) and where their counts live |
| `PORT` | the web app's port inside the container (default 3000) |

`ALLOW_PRIVATE_TARGETS=true` (or `NUXT_ALLOW_PRIVATE_TARGETS=true`) reaches
further in the single container than with Compose: every backend is on the
container's loopback. The app still refuses its own Postgres, Evolution and
bridge by address and port, but not Redis on `127.0.0.1:6379`, so turn it on
only where everyone with an account is trusted — see
[the risky combination](#who-can-sign-up) below.

### Updating

```bash
docker pull ghcr.io/ju-li/automata-mcp-aio:1
docker rm -f automata
docker run -d --name automata …   # the same command as before
```

Migrations run at boot and only go forward, so moving to a new major is a
deliberate edit of the tag. `:1` gets a release only once it has been tested and
promoted; `:beta` gets each one as soon as it is published, for anyone who wants
to try it early. See [Releases](releases.md).

### When to use Compose instead

Choose Compose when you want to restart, upgrade or back up one service without
the others, put Postgres on its own disk, or leave out WhatsApp or Telegram
entirely. The single container always runs all of them.

## Docker Compose

### Start it

```bash
git clone https://github.com/ju-li/automata-mcp.git && cd automata-mcp
cp .env.selfhost.example .env
for k in POSTGRES_PASSWORD WEBHOOK_SECRET EVOLUTION_API_KEY TELEGRAM_BRIDGE_ADMIN_KEY TELEGRAM_SESSION_ENCRYPTION_KEY; do
  echo "$k=$(openssl rand -hex 32)"; done >> .env
```

Set `NUXT_PUBLIC_APP_URL` in `.env` to the address people will open — it is
what every connector URL is built from. Then pick what to run:

```bash
docker compose up -d                                         # database connections only
docker compose --profile whatsapp up -d                      # + WhatsApp (Evolution API, Redis)
docker compose --profile whatsapp --profile telegram up -d   # + Telegram bridge
```

Open the app on port 3000 (`WEB_PORT`) and sign up. The first account creates
an organization and is its admin. The app creates its database schema on first
boot — look for `[app-db] applied migrations` in `docker compose logs web`.

Telegram also needs your own `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from
<https://my.telegram.org>; without them the bridge runs and the app tells an
admin what to set. See [Telegram connections](telegram.md).

Mail is optional: with `SMTP_HOST` empty, [connection alerts](alerts.md) and
invitation emails are not delivered (an invitation link is still shown on
screen when it is created), email verification stays off, and passwords cannot
be reset from the app — see [Password reset](#password-reset). Set
`OPS_ALERT_EMAIL` to have reconnect loops and stuck sessions on your Evolution
server reported to you — see [Telling the operator about a reconnect loop or a stuck session](alerts.md#telling-the-operator-about-a-reconnect-loop-or-a-stuck-session).

`ALLOW_PRIVATE_TARGETS=true` lets connections reach private and loopback
addresses, such as a database on your LAN. It is off by default; read the
risky combination under [Who can sign up](#who-can-sign-up) before turning it
on.

### What it runs

| Service | Image | Profile | Published |
|---|---|---|---|
| `web` | `ghcr.io/ju-li/automata-mcp-web:1` | — | `WEB_PORT` → 3000 |
| `postgres` | `postgres:16.15-alpine` | — | no |
| `redis` | `redis:8.2.9-alpine` | `whatsapp` | no |
| `evolution` | `evoapicloud/evolution-api:v2.3.7` | `whatsapp` | no |
| `telegram-bridge` | `ghcr.io/ju-li/automata-mcp-telegram-bridge:1` | `telegram` | no |

Only the web app is published. Everything else, including the webhooks
Evolution and the bridge send back to the app, travels over the compose
network. The web service's `NUXT_*` variables are set in `docker-compose.yml`
from the handful in `.env`, so one Postgres, one password and one webhook
secret serve all of it.

Put the web app behind a TLS-terminating reverse proxy before anyone else uses
it, and set `NUXT_PUBLIC_APP_URL` to the `https://` address. Claude connects to
the connector URL from its own servers, so it must be reachable from the
internet.

The images are pinned to the major tag `:1`. To update within it:

```bash
docker compose pull && docker compose up -d   # add the same --profile flags
```

Migrations run at boot and only go forward, so moving to a new major is a
deliberate edit of the tag, not something `pull` does for you. A release reaches
`:1` only once it has been tested and promoted; to run each one as soon as it is
published, use `:beta` instead. See [Releases](releases.md).

## Who can sign up

Each self-signup creates a new organization, and its admin can start
connections on your Evolution server and Telegram bridge. So by default nobody
can sign up without an invitation:

| `SIGNUP` (`NUXT_SIGNUP`) | `SIGNUP_CODE` (`NUXT_SIGNUP_CODE`) | Without an invitation |
|---|---|---|
| unset or `invite-only` | unset | only the first account on an empty database — that person becomes admin |
| unset or `invite-only` | set | anyone who enters the code, the first account included |
| `open` | ignored | anyone who finds the URL |

Invitation links work in every mode. Neither variable is required: a new
install with both unset lets you sign up first, and you invite everyone else
from the Organization page.

Until that first signup, a fresh install on a public address belongs to
whoever opens it first. If that window matters, set `SIGNUP_CODE` before you
start the stack (`openssl rand -base64 24`) and hand the code only to people
who should get their own organization.

Plans and billing are off on a self-hosted deployment: there is no plan picker,
no Billing page, and no limit on connections, tokens or members. They exist only
for the hosted offering, behind `NUXT_CLOUD_URL` — see [billing.md](billing.md) —
and you never need to set it.

**`ALLOW_PRIVATE_TARGETS=true` with `SIGNUP=open` is the risky
combination**, with Compose and the single container alike. Any stranger who
signs up can then paste a database or Evolution address such as
`postgres://…@192.168.1.20:5432/…` and the server connects to it for them. The
app still refuses its own Postgres, Evolution and bridge, but not anything else
on your network — in the single container, not Redis either. Keep private targets for deployments where
everyone with an account is trusted, and keep sign-up closed there.

### Email verification

Without it, anyone can register `someone@yourcompany.com` before its owner
does, and the owner can then neither sign up nor accept an invitation sent to
that address. With it, signing up (with or without an invitation) and changing
an account's address both mail a six-digit code and a link, and nothing is
created or changed until one comes back. A signup that is never confirmed holds
no claim on the address and expires after 30 minutes.

| `EMAIL_VERIFICATION` (`NUXT_EMAIL_VERIFICATION`) | Behaviour |
|---|---|
| unset or `auto` | on when `SMTP_HOST` is set, off otherwise |
| `required` | always on; with no SMTP, signups and address changes are refused |
| `off` | never; the password alone proves an address change, as before |

Anything else is read as `required`. The link is built from
`NUXT_PUBLIC_APP_URL` only, never from the request, so a forged `Host` header
cannot redirect it; without that URL the mail carries the code alone. Existing
accounts are not asked to verify.

The account emails are HTML with a plain-text part; their header logo is served
by the web app and linked through `NUXT_PUBLIC_APP_URL` too. See
[Account emails](alerts.md#account-emails).

### Password reset

"Forgot password?" on the sign-in page mails a link and a six-digit code to the
address, and an admin can send the same mail to a member from the
Organization page. Either way only the person with the inbox chooses the new
password: the admin never sees the link or the code. Both expire after 30
minutes and work once. Like the verification link, the reset link is built from
`NUXT_PUBLIC_APP_URL` only; without it the mail carries the code alone.

A reset signs every browser out of the account and then sends the person to
sign in, so two-factor authentication still applies. It does not touch
connector tokens. The address gets a "your password was changed" notice
afterwards, as it does after a change on the profile page.

**It needs SMTP.** Without `SMTP_HOST` the page says passwords cannot be reset
here, and the admin button is hidden. On such a deployment the operator resets
a password in the database. Hash the new password with the web image's own
Node, in the format the app stores:

```bash
docker compose exec web node -e "const c=require('node:crypto');const s=c.randomBytes(16);c.scrypt(process.argv[1],s,64,{N:32768,r:8,p:1,maxmem:67108864},(e,k)=>console.log(['scrypt',32768,8,1,s.toString('base64'),k.toString('base64')].join('\$')))" 'the-new-password'
```

In the single container, run the same with `docker exec <container> /opt/node22/bin/node -e …`.
Then open `psql` — `docker compose exec postgres psql -U automata -d automata`
with Compose (your `POSTGRES_USER` / `POSTGRES_DB` if you changed them), or
`docker exec -it -u postgres <container> psql -h /run/postgresql -d automata`
in the single container — and store it, ending the account's sessions and
pending sign-ins. Write the address in lower case; that is how it is stored.

```sql
BEGIN;
UPDATE app.users SET password_hash = '<the printed scrypt$… string>', updated = now() WHERE email = 'person@example.com';
DELETE FROM app.sessions WHERE user_id = (SELECT id FROM app.users WHERE email = 'person@example.com');
DELETE FROM app.mfa_challenges WHERE purpose = 'login' AND user_id = (SELECT id FROM app.users WHERE email = 'person@example.com');
COMMIT;
```

Check who is asking before you do this, and send the password to them over a
channel you trust.

## ⚠️ WhatsApp pairing burns a real phone number

Scanning the QR binds a real WhatsApp account to an instance. WhatsApp rate-limits
and can ban numbers that pair and unpair repeatedly, or that send unsolicited
messages from a freshly-paired session. **Use a spare SIM, not your primary
number**, and keep test traffic to conversations you control.

## ⚠️ `docker compose down -v` forces a QR re-scan

`-v` deletes the `evolution_instances` volume, which holds every paired session.
Every instance has to be re-paired by scanning a new QR code — see the warning
above about what that costs. For routine restarts use `down` without `-v`:

```bash
docker compose --profile whatsapp --profile telegram down
```

Back up the `postgres_data` volume: it holds every user, connection, stored
credential and synced message.

The single container's equivalent is `docker volume rm` on the volume mounted at
`/data` — it holds the sessions and the database alike. `docker rm` alone is
safe.

## MCP rate limits

Every `/mcp` request counts against per-minute budgets, so one runaway agent
loop cannot hammer the Evolution database, a connected Postgres or a mail
server for everyone else:

| Variable | Default | Budget |
|---|---|---|
| `NUXT_MCP_RATE_TOKEN_PER_MINUTE` | `120` | every request, per connector token |
| `NUXT_MCP_RATE_ORG_PER_MINUTE` | `600` | every request, per organization (all its tokens together) |
| `NUXT_MCP_RATE_EXPENSIVE_PER_MINUTE` | `30` | costly tools only, per connection: `search-messages`, `search-telegram-messages`, `search-emails` with `text`, and `run-query` without `explain` |

With Compose or the single container, set them in `.env` without the `NUXT_`
prefix (`MCP_RATE_TOKEN_PER_MINUTE`, …, and `REDIS_URL` below), as
`.env.selfhost.example` lists them.

Each budget can be spent all at once and refills continuously. `0` turns that
budget off. A request over any budget is refused whole and costs nothing. It
gets **429** with a `Retry-After` header and a JSON-RPC error that says which
budget ran out and when to retry. The token stays valid. The web log gets one
line per budget per minute, with ids only.

**Where the counts live.** By default they are kept in each web process, which
is right for a single replica. With several replicas, each counts on its own and
the effective budget multiplies by the number of replicas. To share the counts,
set `NUXT_REDIS_URL`. It also shares two short-lived caches (the chat listing,
one minute; each WhatsApp connection's history setting, five minutes). Nothing
requires it:

| `NUXT_REDIS_URL` | behaviour |
|---|---|
| unset | counted and cached in-process; one line at boot says so |
| set, unreachable | counted and cached in-process for as long as it is down, logged at most once a minute; requests are never refused because of it |
| set, reachable | shared across replicas and kept across redeploys |

If you point it at a Redis that something else uses, such as Compose's `redis`
service, which Evolution caches into:

- Use a database number of its own, for example `redis://redis:6379/1`.
  Evolution's cache uses `/6`.
- The app writes only keys starting with `automata:`, every one with an expiry
  (one minute for rate-limit counts, at most five minutes for cached values). It never runs `FLUSHALL`, `FLUSHDB`, `CONFIG` or `KEYS`.
- The app never picks up Evolution's `CACHE_REDIS_URI` on its own. Sharing is
  your decision.

## The app database

Everything the app itself keeps is in the `app` schema of `NUXT_DATABASE_URL` —
the same Postgres Evolution writes into (under `public`) and the Telegram bridge
uses (under `telegram`). The schema is `apps/web/server/db/migrations.ts`, applied
in order when the server starts, under an advisory lock and in one transaction;
`app.migrations` records which have run. Migrations are append-only: one that has
been deployed is never edited, because it will not run again anywhere it already
has.

| Table | Holds |
|---|---|
| `users` | email (stored lower-cased), display name, password hash |
| `sessions` | browser sessions — SHA-256 of the cookie, expiry |
| `organizations`, `memberships` | one membership per user (a unique index), with its role |
| `instances` | one row per connection, `kind` of `whatsapp`, `postgres`, `telegram` or `imap` |
| `instance_assignments` | "may use, not manage" grants to members |
| `invitations` | SHA-256 of the invitation code, address, role, expiry |
| `mcp_tokens` | SHA-256 of the connector token, holder, scope, expiry, `last_used_at` |
| `mcp_token_clients`, `mcp_tool_calls` | which MCP clients used each token, and the Telemetry tool-call history (kept 30 days) |
| `whatsapp_groups`, `whatsapp_group_scans` | WhatsApp group names and sizes from slow, one-group-at-a-time lookups, and when each account last ran them — see [WhatsApp](whatsapp.md) |
| `totp_credentials`, `webauthn_credentials`, `recovery_codes`, `mfa_challenges` | second sign-in factors — see [Two-factor authentication](two-factor.md) |
| `email_verifications` | signups and address changes waiting to be confirmed — see [Email verification](#email-verification) |
| `password_resets` | password resets waiting to be used — SHA-256 of the link and of the code, attempts, expiry (30 minutes); one per account — see [Password reset](#password-reset) |
| `mail_sync_state`, `mail_folders`, `mail_messages` | synced IMAP headers, never bodies — see [Email (IMAP) connections](imap.md) |
| `hosted_events`, `entitlement_defaults` | the hosted offering only; empty on a self-hosted deployment — see [billing.md](billing.md) |

An `instances` row carries, by kind:

- **WhatsApp** — the Evolution instance's `name` and `instance_id`, its
  `base_url`, and the per-instance `api_key`. A bring-your-own connection also
  carries its server's `admin_key` and, once supplied, `evolution_db_url`.
- **Postgres** — the `dsn`, plus `db_host`, `db_port` and `db_database` for
  display. Nothing connects through the display three.
- **Telegram** — the bridge's `base_url`, the session's `instance_id` and
  `api_key`, and for a bring-your-own bridge its `admin_key` and `telegram_db_url`.
- **IMAP** — `imap_host`, `imap_port`, `imap_security`, `imap_user` and
  `imap_password`.

Two more columns, `down_since` and `alerted_at`, carry outage state — see
[Connection alerts](alerts.md). On WhatsApp rows, `row_churn_since` and
`row_churn_seen_at` track a reconnect loop, and `paired_at` records the first
time the account was seen linked. A WhatsApp row still without `paired_at` an
hour after it was created is deleted — see
[WhatsApp](whatsapp.md#connections-never-paired-are-removed-after-an-hour).

`api_key`, `admin_key`, `dsn`, `evolution_db_url`, `telegram_db_url` and
`imap_password` never leave the server — `toPublicInstance()` is the only projection the UI receives —
but they are **not encrypted**: they sit in clear in the database and in every
backup of it. So treat `NUXT_DATABASE_URL` and the database's backups as holding
every connected account.

Foreign keys say what deleting does. A user's tokens, sessions, memberships and
assignments go with them; a connection's tokens and assignments go with it. An
organization that still owns connections **cannot** be deleted, and a connection
does not go with its creator — a cascade there would drop rows pointing at live
WhatsApp sockets without ever telling Evolution.

To start over locally, drop the schema; the next boot recreates it:

```bash
psql postgres://evolution:change-me@localhost:5432/evolution -c 'DROP SCHEMA app CASCADE'
```

## Coming from PocketBase

Versions before this one kept all of this in PocketBase. A deployment still on
PocketBase must first deploy commit `2e1872e` (the merge of ju-li/automata-mcp#46), which imports
every user, password, connection and token into this schema on its first boot —
see [the README at that commit](https://github.com/ju-li/automata-mcp/blob/2e1872e/README.md), "Moving off PocketBase". Accounts imported that way
keep their bcrypt password hash until they next sign in, when it is replaced with
scrypt.
