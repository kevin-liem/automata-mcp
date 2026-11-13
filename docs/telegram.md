# Telegram connections

`apps/telegram-bridge` is to Telegram what Evolution is to WhatsApp: a separate
service that holds each linked account's session, keeps its chats in Postgres,
and answers the app over HTTP. Nothing off the shelf does this for a *personal*
account linked by QR code, so it lives in this repo. It is built on
[teleproto](https://www.npmjs.com/package/teleproto), the maintained GramJS fork.

> ⚠️ **Read Telegram's terms before offering this to anyone.** Telegram's API
> Terms of Service and its content-licensing terms forbid using data from the
> platform for artificial intelligence, with an exception only where everyone in
> a chat has consented. Accounts that sign in through unofficial clients are also
> watched more closely than official ones, and one that breaks the terms can be
> restricted or banned. This project ships the integration and does not make
> that risk go away.

## Setting it up

1. **Get your own API credentials** at <https://my.telegram.org> → API
   development tools, and put them in `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
   Never reuse a pair from an example or another project — Telegram refuses
   published ones. Both are optional, together: with neither set the bridge
   still starts, `/health` reports `"telegram": "unconfigured"`, and the app's
   **Add a connection** page says what to set instead of offering Telegram.
   Setting both later and restarting the bridge is all it takes to turn it on.
   One without the other refuses to start, so a typo cannot pass for "off".
2. **Generate the two keys:** `TELEGRAM_BRIDGE_ADMIN_KEY` (`openssl rand -hex
   24`) and `TELEGRAM_SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`). Set
   `NUXT_TELEGRAM_ADMIN_KEY` to the same value as the admin key.
3. **Give the bridge its database:** `TELEGRAM_BRIDGE_DATABASE_URL`, required —
   the bridge refuses to start without it (see
   [Where the data lives](#where-the-data-lives)). It listens on
   `TELEGRAM_BRIDGE_PORT`, else `PORT`, else 8095 — on Railway, which injects
   `PORT=8080`, set `TELEGRAM_BRIDGE_PORT` so the app's URL keeps working.
4. **Point the app at it:** `NUXT_TELEGRAM_URL` and
   `NUXT_TELEGRAM_DATABASE_URL`. The bridge reports a dropped or restored
   connection to `NUXT_TELEGRAM_WEBHOOK_URL`, which drives disconnect alerts and
   defaults to `NUXT_PUBLIC_APP_URL` + `/api/webhook/telegram`; set it in
   development, where a bridge in a container cannot reach `localhost` on the
   host. `.env.example` has working development values.
5. `pnpm services:up:telegram`, restart `pnpm dev`, and create a **Telegram
   account** connection. Until `NUXT_TELEGRAM_URL` and `NUXT_TELEGRAM_ADMIN_KEY`
   are both set, creating one is refused with "No Telegram bridge is available"
   unless the user supplies their own bridge.

**The encryption key is the most sensitive value the bridge has.** Every stored
session is sealed with it, and each session is full access to that Telegram
account. Losing or changing it unlinks every account; leaking it together with a
database backup hands every account over.

## Where the data lives

In the **same Postgres database Evolution uses**, in its own `telegram` schema.
The bridge creates the schema and its tables on first start and never touches
`public`, where Evolution's tables are, so the two cannot collide. On Railway that
means one Postgres service for both.

The bridge connects with the database's owner credential — the same URL
Evolution has. That is a deliberate trade for a simpler setup: the credential can
read every WhatsApp message in that database, so a compromised bridge is a
compromised Evolution. If you want the app to read Telegram data with less, create
a role with `LOGIN` and nothing else, set `TELEGRAM_READER_ROLE` to its name on
the bridge (it re-grants `SELECT` at every start: on `messages` whole, on `chats`
and `users` column by column so access hashes and phone numbers stay out, and
never on `sessions`), and use that role in `NUXT_TELEGRAM_DATABASE_URL`.

The bridge migrates its schema at start, in one transaction. Migration `0003`
adds an index on `telegram.messages` and holds a write lock on that table while it
builds, so sync writes wait for it. With millions of messages, build it by hand
beforehand without the lock and the migration skips it:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_live_by_session
  ON telegram.messages (session_id) WHERE deleted_at IS NULL;
```

If that build fails, it leaves an invalid index under the same name. Drop that
index and build it again before you deploy.

Migration `0005` sets `telegram.messages` to vacuum more often than Postgres's
default (`autovacuum_vacuum_insert_scale_factor = 0.01`,
`autovacuum_vacuum_scale_factor = 0.02`). The per-session counts behind each
connection's status read only that index, but only for pages the visibility map
marks all-visible; at the default thresholds a busy table falls behind, and the
counts read the table instead until the status request times out. It changes
storage parameters only and blocks neither reads nor writes. To catch up at once
on a large table that has run without it, vacuum it by hand after deploying:

```sql
VACUUM (ANALYZE) telegram.messages;
```

`SELECT relallvisible::float / relpages FROM pg_class WHERE oid = 'telegram.messages'::regclass`
should then stay close to 1.

## What syncs

Private chats, bots, groups, supergroups (including forum topics) and channels —
live, plus older history fetched in the background. Edits replace the message
text, reactions are counted on the message, and a deleted message loses its
text rather than staying readable.

Backfill is **slow on purpose**: one page of 100 messages at a time with a pause
of `TELEGRAM_BACKFILL_PAGE_DELAY_MS` (default 1000) between pages, newest chats
first, stopping at `TELEGRAM_BACKFILL_MAX_PER_CHAT` messages (default 2000) or
`TELEGRAM_BACKFILL_DAYS` days (default 365) per chat, and skipping broadcast
channels unless `TELEGRAM_BACKFILL_BROADCAST=true`. An unofficial client that
hammers history is how an account gets restricted. The read tools say when a
chat's history stops at what was synced rather than at its first message.

The day limit is a limit on what is stored, not only on how far backfill walks:
the page that crosses it is cut at it, and a chat whose newest message is older
than the limit gets no message from the dialog list either. Live messages and
the catch-up after a restart are never cut.

The app can lower the limit for one session: it sends `backfillDays` with
`POST /sessions/:id/pair`, the bridge stores it on the session, and the lower of
it and `TELEGRAM_BACKFILL_DAYS` applies — a session can be held below the
operator's setting, never lifted above it. The hosted Free plan uses this for
90 days (see [Plans and billing](billing.md)). Because it is stored at pairing,
it applies to the account linked then; `GET /sessions/:id/state` reports the
limit in force as `sync.backfillDays`, which the dashboard and
`get-telegram-status` (`sync.historyDays`) show.

**A very busy account is caught up rather than queued.** Live updates are
written in the order they arrive. When they come in faster than they are written
— more than 5,000 waiting, or the oldest waiting two minutes — the bridge stops
holding channel and supergroup updates in memory and fetches them from Telegram
again once it has caught up, one channel at a time. Nothing is lost by this;
where Telegram itself will not go back far enough, the chat is marked as having a
gap, as after any other outage. Private chats and basic groups are never skipped.
While a session has a backlog the bridge logs it once a minute (with its heap
size), and `GET /health` reports the totals under `sync`: `pending`,
`maxPending`, `oldestPendingSeconds`, `sheddingSessions`, `dirtyChannels`,
`heapUsedMb`. A backlog that never drains means the database cannot keep up.

**Secret chats are never visible.** They exist only on the devices that took
part in them and cannot be synced by any client.

**Unlinking deletes the synced chats**, whether through **Unlink** on the
dashboard or by deleting the connection. A session ended from Telegram → Devices
keeps them, because the likeliest next step is linking the same account again.

## One bridge process at a time

Two processes using the same Telegram session make Telegram kill it, which costs
a QR scan. The bridge takes a Postgres advisory lock per session, so a second
process waits rather than connecting, and takes the session over within about 30
seconds of the first one stopping. Run it as **one instance**, and do not give it
a deployment overlap: while two copies run, the one without the lock reports those
connections as held elsewhere. A short overlap is harmless — alerts wait ten
minutes for that state — but it buys nothing.

A client that stops reconnecting on its own — Telegram unreachable for longer
than teleproto's retries, or no answer for two minutes — is rebuilt by the
bridge without a restart. The log says
`[sessions] <id>: client stopped reconnecting (…); rebuilding`, then
`connected again` once it is back. Failed attempts back off from 30 seconds,
doubling to a 10-minute cap.

## Bring your own bridge

**Self-hosted only**, like a bring-your-own Evolution server: the hosted
service refuses it and doesn't offer the option.

Like Evolution, a user can tick **Use my own Telegram bridge** and give its URL,
admin key and, optionally, a database URL for reading its chats. The URL passes
the same outbound host guard as a user's Evolution server, this deployment's
admin key is never sent to it, and theirs is never sent to ours.

## Developing against Telegram's test servers

`TELEGRAM_TEST_SERVERS=true` points the bridge at Telegram's separate test
environment, where accounts use numbers of the form `99966XYYYY`. That
environment is separate from the real one: an account from one does not exist in
the other, so link a test bridge only from a test account.
