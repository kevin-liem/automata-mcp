# Deploying to Railway

Up to five services. Two are built from this repo; Redis and evolution you
provision only for WhatsApp, the Telegram bridge only for Telegram. Postgres is
always there — it holds the app's own tables. A deployment that serves database
connections alone is **Postgres** and **web**.

| Service | Source | Target port | Volume |
|---|---|---|---|
| **Postgres** | Railway template | — | managed |
| **Redis** *(WhatsApp only)* | Railway template | — | managed |
| **evolution** *(WhatsApp only)* | image `evoapicloud/evolution-api:v2.3.7` | 8080 | `/evolution/instances` |
| **telegram-bridge** *(Telegram only)* | image `ghcr.io/ju-li/automata-mcp-telegram-bridge:1`, or this repo, root directory `/`, Dockerfile path `/apps/telegram-bridge/Dockerfile` | 8095 | — |
| **web** | image `ghcr.io/ju-li/automata-mcp-web:1`, or this repo, root directory `/`, Dockerfile path `apps/web/Dockerfile` | Railway's `PORT` (8080 unless you set it) | — |

The published images are the simpler route and the one a Railway template uses —
see [Releases](releases.md). Building from the repo is for running unreleased code.

When built from the repo, the web service and the Telegram bridge build from the **repo root**, not their
`apps/` directory — the lockfile and workspace manifest live there. Leave the root
directory at `/` and set the Dockerfile path. A root directory of
`/apps/telegram-bridge` fails the build with `"/pnpm-workspace.yaml": not found`.
If you use watch paths, the bridge needs `/apps/telegram-bridge/**` and
`/pnpm-lock.yaml`.

The bridge needs no volume: its sessions and chats are in Postgres.

> **The evolution volume is not optional.** Without `/evolution/instances`, every
> deploy unpairs every WhatsApp account and forces a fresh QR scan on each one.
>
> Attach it in the service's settings. Railway rejects a `VOLUME` instruction in a
> Dockerfile — *"docker VOLUME at Line N is not supported, use Railway Volumes"* —
> so no image declares one, and nothing warns you at deploy time if you forget.
>
> Users, connections and tokens are in Postgres now, so back that up: its backups
> hold every stored credential.

A deployment that still has a **pocketbase** service from an earlier version can
delete it, and its volume, once its data has been imported — see [Coming from PocketBase](self-hosting.md#coming-from-pocketbase).

## Pin the ports

**Railway injects `PORT` (8080 by default) into every service, and both images
follow it.** So a service listens on Railway's port, not on the default in its
Dockerfile — point another service at the wrong one and you get `ECONNREFUSED`
from a hostname that resolves perfectly well.

Set these explicitly so nothing depends on Railway's default:

| Service | Variable |
|---|---|
| evolution | `SERVER_PORT=8080` (Evolution reads this, not `PORT`) |
| telegram-bridge | `TELEGRAM_BRIDGE_PORT=8095` (it follows `PORT` only when this is unset) |
| web | nothing — it is the public service, let Railway assign it |

Then the internal URLs below match, and each service's target port matches the
table above.

## Environment

Use Railway's variable references (`${{Service.VAR}}`) so a rotated secret
propagates instead of drifting out of sync.

**evolution** *(WhatsApp only)*

```
SERVER_PORT=8080
SERVER_URL=https://<evolution-domain>
AUTHENTICATION_API_KEY=<openssl rand -hex 16>
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=${{Postgres.DATABASE_URL}}?schema=public
DATABASE_CONNECTION_CLIENT_NAME=evolution_exchange
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
DATABASE_SAVE_DATA_HISTORIC=true
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=${{Redis.REDIS_URL}}/6
CACHE_REDIS_PREFIX_KEY=evolution
CACHE_LOCAL_ENABLED=false
WEBHOOK_GLOBAL_ENABLED=false
TELEMETRY_ENABLED=false
```

`WEBHOOK_GLOBAL_ENABLED=false` is deliberate. The app registers a webhook **per
connection** instead, and Evolution fires the global and per-instance deliveries
independently — so with both on, every event arrives twice. The global one also
sends no custom headers, so once `NUXT_WEBHOOK_SECRET` is set that copy 401s on
every event and is dropped rather than retried. Turning it back on buys no
coverage either: it never reached a connection on a user's own Evolution server.

The `DATABASE_SAVE_DATA_*` flags are what populate the dashboard counts and make
`list-chats` and `read-messages` return anything. Turn them off and those tools
go quiet.

`DATABASE_SAVE_DATA_HISTORIC` is the odd one out: the others cover live traffic,
that one covers the history WhatsApp hands over *once*, when a number is paired.
Evolution checks it in the `messaging-history.set` handler and silently drops the
whole payload if it is false — with no way to ask for the history again short of
disconnecting and re-scanning the QR. See [Importing existing history](whatsapp.md#importing-existing-history).

**telegram-bridge** *(Telegram only)*

```
TELEGRAM_BRIDGE_PORT=8095
TELEGRAM_API_ID=<from my.telegram.org, or empty>
TELEGRAM_API_HASH=<from my.telegram.org, or empty>
TELEGRAM_BRIDGE_ADMIN_KEY=<openssl rand -hex 24>
TELEGRAM_SESSION_ENCRYPTION_KEY=<openssl rand -hex 32>
TELEGRAM_BRIDGE_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

`TELEGRAM_API_ID` / `TELEGRAM_API_HASH` may be left empty (both of them) on a
deployment that does not need Telegram yet: the bridge runs without it and the
app tells an admin what to set. Setting both redeploys the service on Railway,
and Telegram is available from then on.

The database URL is the same one Evolution uses; the bridge keeps to its own
`telegram` schema — see [Where the data lives](telegram.md#where-the-data-lives). The backfill variables in
`.env.example` are optional. **Keep this service at one replica and leave
`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` unset (it defaults to 0)** — see [One bridge process at a time](telegram.md#one-bridge-process-at-a-time). Losing `TELEGRAM_SESSION_ENCRYPTION_KEY` unlinks every
account, so keep a copy somewhere other than Railway.

If the service has a memory limit, set `NODE_OPTIONS=--max-old-space-size=<MB>`
to about three quarters of it, so Node stops with a heap error in the log rather
than the container being killed without one. The bridge bounds its own backlog
(see [What syncs](telegram.md#what-syncs)); this is the back-stop.

**web** — internal addresses for the backends, public URLs for anything a user sees:

```
NUXT_DATABASE_URL=${{Postgres.DATABASE_URL}}
NUXT_PUBLIC_APP_URL=https://<web-domain>

# Mail. Optional — with NUXT_SMTP_HOST empty, alerts and invitation emails are
# computed and not delivered, email verification is off and "Forgot password?"
# is unavailable (see self-hosting.md#password-reset).
NUXT_SMTP_HOST=<smtp host>
NUXT_SMTP_PORT=587
NUXT_SMTP_USERNAME=<username>
NUXT_SMTP_PASSWORD=<password>
NUXT_SMTP_TLS=false          # false = STARTTLS on 587; true = implicit TLS on 465
NUXT_MAIL_FROM=<a from address the provider will accept>
NUXT_MAIL_FROM_NAME=DOPE
NUXT_OPS_ALERT_EMAIL=<your address>   # optional; reconnect loops and stuck sessions on this Evolution (alerts.md)

# Checked on both Evolution's and the Telegram bridge's webhooks
NUXT_WEBHOOK_SECRET=<openssl rand -hex 32>

# WhatsApp only
NUXT_EVOLUTION_URL=http://evolution.railway.internal:8080    # matches SERVER_PORT above
NUXT_EVOLUTION_ADMIN_KEY=${{evolution.AUTHENTICATION_API_KEY}}
NUXT_EVOLUTION_DATABASE_URL=${{Postgres.DATABASE_URL}}
NUXT_WEBHOOK_URL=https://<web-domain>/api/webhook/evolution

# Telegram only
NUXT_TELEGRAM_URL=http://<telegram-bridge-service>.railway.internal:8095   # matches TELEGRAM_BRIDGE_PORT
NUXT_TELEGRAM_ADMIN_KEY=${{telegram-bridge.TELEGRAM_BRIDGE_ADMIN_KEY}}
NUXT_TELEGRAM_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

`NUXT_TELEGRAM_WEBHOOK_URL` is not needed here: the bridge posts to
`NUXT_PUBLIC_APP_URL` + `/api/webhook/telegram`.

`NUXT_DATABASE_URL` is the database's owner, on purpose: the app creates and
migrates its own `app` schema at boot, beside Evolution's tables and the bridge's
`telegram` schema. It holds every stored credential, and the app refuses any
user-supplied connection that resolves to it.

`NUXT_PUBLIC_APP_URL` is what connector URLs are built from. Get it wrong and
every token you hand out points at the wrong host.

`NUXT_EVOLUTION_ADMIN_KEY` is the most sensitive value in the deployment: it can
create, read and delete every user's WhatsApp connection.

`NUXT_EVOLUTION_DATABASE_URL` points at the same Postgres service Evolution uses.
The owner's URL is fine — the app only sends its own parameterised SELECTs there,
in sessions opened read-only. To narrow it to a SELECT-only role instead, create
`wamcp_search` from [Reading and searching messages](whatsapp.md#reading-and-searching-messages) and use its URL here.

**Set `NUXT_WEBHOOK_SECRET`.** The app registers a webhook per connection and
attaches it as `x-webhook-secret`; per-instance webhooks are the only ones
Evolution sends custom headers on. That is also why `WEBHOOK_GLOBAL_ENABLED` is
off above — the global webhook sends none, so with a secret set every global
delivery would 401, which Evolution treats as non-retryable and drops.

**Keep the web service at one replica.** The five-minute connection sweep runs
in-process, so a second replica means a second sweep and duplicate alert emails.

**Leave `NUXT_ALLOW_PRIVATE_TARGETS` unset.** It defaults to off, which is right
for any deployment more than one person uses — see [Database connections](postgres.md).

**Sign-up is invite-only unless you say otherwise.** With `NUXT_SIGNUP` unset,
the first account on the new database gets through and everyone after joins by
invitation. Set `NUXT_SIGNUP_CODE` on the web service to let holders of that
code create their own organization; it is then required for the first account
too. `NUXT_SIGNUP=open` lets anyone who finds the domain sign up. See
[Who can sign up](self-hosting.md#who-can-sign-up). Once SMTP is configured,
new signups and address changes are verified by email — see
[Email verification](self-hosting.md#email-verification).

**Lock sign-in email addresses.** Set `NUXT_DISABLE_EMAIL_CHANGE=true` on the
web service to make the email address read-only in Profile for all accounts.
This also blocks pending address changes from being confirmed. Signup email
verification follows `NUXT_EMAIL_VERIFICATION`.

## First run

Nothing to do. The web service creates its schema in Postgres on first boot —
look for `[app-db] applied migrations` in its logs.

Then open the web service's domain and sign up. The first account becomes
the admin; invite everyone else from the Organization page.

## Postgres sizing

Railway's Postgres template starts with the stock settings, sized for a small
machine: `shared_buffers` 128 MB and `max_connections` 500. Production runs
with these instead, set once as a superuser (`railway connect Postgres`):

```sql
ALTER SYSTEM SET shared_buffers = '2GB';
ALTER SYSTEM SET effective_cache_size = '6GB';
ALTER SYSTEM SET max_connections = 150;
```

`ALTER SYSTEM` writes `postgresql.auto.conf` in the data directory
(`/var/lib/postgresql/data/pgdata`), which is on the service's volume, so the
settings survive redeploys. `shared_buffers` and `max_connections` take effect
only at the next restart of the Postgres service; check with `SHOW` afterwards.
To undo one, run `ALTER SYSTEM RESET <name>;` and restart.

- **`shared_buffers` 2 GB.** At 128 MB, about a third of block reads were served
  from Postgres's own cache. The rest went to the kernel's file cache.
- **`effective_cache_size` 6 GB** is a hint to the planner and allocates
  nothing.
- **`max_connections` 150, not 100.** Count the connection budget before you
  lower it or add a pool. Each process's pool ceiling: web 18 (app 10, Evolution
  reads 3 + 2, Telegram reads 3), Telegram bridge 11 (10 + 1 for its lock
  connection), cloud 5. Evolution sets no `connection_limit`, so Prisma uses its
  default of `2 × vCPU + 1`. Add each Postgres connection pointed at this
  database (up to 3 each), double the ceiling of whichever service is mid-deploy,
  and multiply by replicas. Postgres also keeps 3 slots back for superusers.
  `SELECT usename, application_name, count(*) FROM pg_stat_activity GROUP BY 1, 2`
  shows the live split. Evolution's connections are the ones with no
  `application_name`.
- **`work_mem` stays at 16 MB.** The temp files written to disk come from full
  scans of `"Message"`. Raising it would only let those scans use more memory.

**The memory graph is mostly file cache, and these settings don't shrink it.**
Railway counts the kernel's cache of the data files as the container's memory,
and the kernel fills that cache up to the service's limit. So the graph follows
the size of `"Message"` and how much of it gets scanned, not what Postgres
needs. The cache is reclaimable, so a large graph is not a sign of memory
pressure. Two ways to bring it down: set a memory limit on the service, which
makes the kernel evict cache instead of growing it, or read less of `"Message"`.
Production has no limit, by choice.

## Notes

- **Restart Evolution after restarting Postgres.** Evolution's writes fail while
  Postgres is down, and that can leave a WhatsApp account's session stuck: it
  reads connected, but nothing is sent or received (see
  [whatsapp.md](whatsapp.md) "Stuck with the socket dead"). Restarting the
  Evolution service once Postgres is back reconnects every account without a
  QR scan. This includes restarts Railway makes itself and the one
  `shared_buffers` above needs.
- **Do not ship a `.env`.** It is gitignored, and Railway variables replace it.
- **`host.docker.internal` does not exist here.** The webhook uses the public
  HTTPS URL instead, which is the only thing that differs between dev and prod —
  and it differs by configuration, not code.
- Both containers built from this repo bind `::`, which accepts IPv4 and IPv6. Railway environments
  created before 16 October 2025 route the private network over IPv6 only, where
  binding `0.0.0.0` is unreachable internally.
- `docker-compose.dev.yml` is for local development only. Nothing in it is used
  by Railway.
