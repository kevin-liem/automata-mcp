# WhatsApp connections

## Reading and searching messages

`NUXT_EVOLUTION_DATABASE_URL` is **required** for accounts on this deployment's
Evolution server. `read-messages` and `search-messages` read Evolution's Postgres
directly, and `get-whatsapp-media` uses it to look up the requested message.
Pairing, `list-chats` and `send-text-message` still work without it. The app
reports the missing setting at startup.

**Searching.** Evolution 2.3.7 cannot search message content. `POST
/chat/findMessages` accepts a `where.message` — its request schema even documents
the field — and then never reads it, so a content search comes back as an
unfiltered page that looks like a result set. The only filters it honours are
`id`, `source`, `messageType`, a `messageTimestamp` range, and
`key.{id,remoteJid,fromMe,participant}`. Reading the database instead also reaches
text WhatsApp stores a level or two down — an album item's caption under
`associatedChildMessage`, an edit's new wording under
`protocolMessage.editedMessage` — which no top-level extractor could see.

**Reading.** Evolution stores a message more than once. Its history import
deduplicates against an in-memory set of message ids rebuilt at the start of each
batch, and the `createMany` behind it asks to skip duplicates — which does
nothing, because the only unique constraint on `Message` is a generated primary
key that cannot collide. So two batches in flight together, or an import racing
live traffic, both insert; re-pairing an account is what puts them in flight. The
copies disagree about who sent the message, because each carries whatever push
name was on the wire at the time — a real name, a bare LID, or the sender's own
device-locale word for themselves. Left alone, one message is three, a five-day
range reports triple the messages it holds, and pages come back ragged. The
endpoint cannot fix it: it pages with `skip`/`take` over the duplicate rows, so
the page boundaries are already wrong by the time anything could collapse them.
`DISTINCT ON (key->>'id')` before `LIMIT` is the fix, and that means SQL.

Reactions are dropped in the same query, on the payload rather than on
`messageType`. WhatsApp's own control records cannot be — `messageType` carries no
subtype, and excluding `protocolMessage` wholesale would delete every message edit
along with the bookkeeping — so those are dropped after the rows are read and
counted back to the caller as `protocolMessagesExcluded`.

**Which credential.** The same URL as `NUXT_DATABASE_URL` works, and it is what
the [Railway setup](deploy-railway.md) uses. Every query the app sends here is fixed SQL with
bound parameters — nothing a model or a user writes reaches this connection as
SQL — and the pool opens each session with `default_transaction_read_only`, so a
write fails even under a superuser. That setting is a backstop, not a boundary: a
superuser can switch it off, but only through SQL, and the app never sends any it
did not write.

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://evolution:change-me@localhost:5432/evolution
```

**Optional hardening: a role that can do nothing else.** This connection reaches
every user's messages in every instance. A dedicated role does not protect them
from a compromised web service — that process already holds `NUXT_DATABASE_URL`,
the database's owner — but it does contain a bug in the app's own message queries
to reading `"Message"`, where under the owner such a bug would reach every stored
credential in the `app` schema. If you want that, the grants below serve reading,
searching, connection status and group names:

```sql
CREATE ROLE wamcp_search LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE evolution TO wamcp_search;
GRANT USAGE ON SCHEMA public TO wamcp_search;
GRANT SELECT ON "Message" TO wamcp_search;
-- Connection status: the account's own row and per-account counts.
GRANT SELECT ("id", "connectionStatus", "ownerJid", "profileName", "profilePicUrl", "number", "disconnectionAt", "updatedAt")
  ON "Instance" TO wamcp_search;
GRANT SELECT ("instanceId") ON "Chat", "Contact" TO wamcp_search;
-- Group names, read from Evolution's own chat rows.
GRANT SELECT ("remoteJid", "name") ON "Chat" TO wamcp_search;
```

The `"Instance"` grant is column by column on purpose: the same row holds
`token`, every instance's API key, and this role has no reason to read it.

**Why status reads this database at all.** Evolution's `fetchInstances` answers
with message, chat and contact counts that Prisma computes over *every* account's
rows and joins to the one asked about — a full scan of `"Message"` on every call.
With this URL set, the dashboard, the connection list, the alert sweep and
`get-connection-status` read the account's `"Instance"` row by primary key, and
count only that account's rows, caching the counts for five minutes (the history
import screen after pairing asks for them fresh; the alert sweep reads no counts
at all). A role created before these grants existed still works: status falls
back to `fetchInstances`, cached per connection for five minutes, and the web
log says a grant is missing. Without this URL at all — a bring-your-own server
with no database URL — that cached fallback is the only path.

`"updatedAt"` is what tells a reconnect loop from a healthy connection (see
"Stuck reconnecting" below). It has no fallback: without the grant everything
else keeps working, the log says the column is unreadable, and loops go
undetected.

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://wamcp_search:change-me@localhost:5432/evolution
```

Evolution ships `@@index([instanceId])` and nothing else — no index on
`messageTimestamp`, none on the `key` JSONB — so reading and searching are both a
sequential scan within one account. History import makes that corpus much larger than it would
otherwise be: a number with years of conversations arrives all at once at
pairing, rather than accumulating. The queries carry a 10-second
`statement_timeout` so a slow scan surfaces as an error instead of a hung MCP
call. Once a scan starts timing out, add (as a Postgres superuser, not as the
app):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_instance_ts_idx
  ON "Message" ("instanceId", "messageTimestamp" DESC);
```

Worth knowing before you go looking for a bug:

- Both cover whatever Evolution holds: the history imported at pairing plus
  everything since. An account paired before full-history sync was turned on has
  only what arrived after — see [Importing existing history](#importing-existing-history).
- Reads are deduplicated by message id, so `totalMatching` counts distinct
  messages and can be quoted as an answer. It will often be smaller than the row
  count Evolution's own API reports for the same range. The two are not
  comparable, and the smaller one is the true one.
- **The dashboard's chat count and `list-chats` count different things.** The
  count is every conversation the phone listed at pairing; `list-chats` lists
  conversations Evolution holds messages for, which is routinely fewer. The gap
  is not more pages — `hasMore` is the only signal that there are.
- **There are no unread counts.** Neither `list-chats` nor the dashboard says
  which chats are unread, and the tool tells the model so. Evolution 2.3.7 does
  not keep the one signal that says a chat was read on the phone, and an unread
  count derived from message statuses was tried and found wrong (651 "unread" on
  an account with no unread badges).
- **Group names can lag behind a rename by up to a week.** Asking WhatsApp for
  all of an account's groups at once costs two WhatsApp queries per group, fired
  together, and drew `rate-overlimit` answers on large accounts however rarely
  it ran — so it is never done. Group names come from Evolution's own chat rows
  (`"Chat".name`), which cost WhatsApp nothing but are written once, when the
  chat first arrives, and never updated on a rename. Groups with no name there,
  and every group once a week, are looked up one at a time — at most four per
  account every 15 minutes, five seconds apart — and the answers kept in
  `app.whatsapp_groups`. So a renamed group shows its old name until its next
  lookup, a group with no stored name shows the contact name or bare id until
  its first one, and a group's member count appears only once it has been
  looked up. Without the `"Chat"` grant above, names come from the lookups
  alone, and a warning says so in the log. Chats and their last messages are
  read live; only group names lag.
- The scope editor lists the tools of the connection's own kind, and lists both
  read tools whether or not the database URL is set. It deliberately does not
  hide a tool with an unmet prerequisite: both read tools need that URL, so
  hiding one would leave a scope editor that disagrees with the tool list a
  client actually sees. An unset URL is reported at startup instead.
- **A connection on your own Evolution server needs its own database URL.** This
  variable names one database — the one belonging to the Evolution server this
  app is configured with — and a bring-your-own connection's messages live in
  that server's database instead. Supply it when creating the connection, or from
  its dashboard afterwards (**Enable reading**); it is stored on the connection,
  not here. Until then reads answer 501 naming the missing setting rather than
  matching nothing and reporting an empty conversation. Pairing, chat listing and
  sending never need it.

  Same shape of role as above, in *your* database:

  ```sql
  CREATE ROLE evo_reader LOGIN PASSWORD 'change-me';
  GRANT CONNECT ON DATABASE evolution TO evo_reader;
  GRANT USAGE ON SCHEMA public TO evo_reader;
  GRANT SELECT ON "Message" TO evo_reader;
  GRANT SELECT ("id", "connectionStatus", "ownerJid", "profileName", "profilePicUrl", "number", "disconnectionAt", "updatedAt")
    ON "Instance" TO evo_reader;
  GRANT SELECT ("instanceId") ON "Chat", "Contact" TO evo_reader;
  GRANT SELECT ("remoteJid", "name") ON "Chat" TO evo_reader;
  ```

  It is checked before it is stored — including that `"Message"` is actually
  readable, because a URL that connects to the *wrong* database is otherwise
  indistinguishable from an account with no messages.

On Railway, Evolution's Postgres is its own service — use its private URL, and
note the port there is whatever that service actually listens on (see "Pin the
ports").

## Retrieving media

Call `get-whatsapp-media` with the chat's `jid` and pass the message's `id` as
`messageId`. Both values come from `read-messages` or `search-messages`. A token
with an explicit tool allowlist must include `get-whatsapp-media`, and the chat
must be within the token's scope.

Copy the **exact ID of the audio entry**, not another message's ID or an ID
inferred from a timestamp. `[voice message]` is a placeholder, not a transcript.
A 422 for a non-media message identifies its stored type and directs the caller
back to the listing; it does not mean a different recording has expired.

The tool fetches one image, video, audio recording, document or sticker on
demand, up to **10 MiB (10,485,760 decoded bytes)**. It preserves the downloaded
bytes; it does not convert file formats. Older attachments can expire even when
the message still appears in history. View-once media is refused.

With the default `delivery: "native"`, the MCP tool result has a `content` array. The first block is
`{ "type": "text", "text": "<JSON metadata>" }`, where the metadata contains
`jid`, `messageId`, `filename`, `mimeType`, decoded byte `size`, `delivery` and
the complete file's `sha256`. The second
block contains the file:

| File format | MIME type | MCP content block |
| --- | --- | --- |
| JPEG, PNG, GIF, WebP (including WebP stickers) | `image/jpeg`, `image/png`, `image/gif`, `image/webp` | `{ "type": "image", "mimeType": "…", "data": "<base64>" }` |
| Ogg/Opus voice notes, MP3, M4A, WAV and other audio | `audio/ogg`, `audio/mpeg`, `audio/mp4`, `audio/wav`, other `audio/*` | `{ "type": "audio", "mimeType": "…", "data": "<base64>" }` |
| MP4 and other video, including round video messages | `video/mp4`, other video MIME types | `{ "type": "resource", "resource": { "uri": "…", "mimeType": "…", "blob": "<base64>" } }` |
| PDF, Office files, text, archives, HEIC and other formats | Original MIME type, or `application/octet-stream` when unknown | Same embedded `resource` shape |

`data` and `blob` are standard padded base64 strings, without a `data:` prefix.
MIME types are lower-cased and parameters are removed: an Opus voice note
reported as `audio/ogg; codecs=opus` is returned as `audio/ogg`, with unchanged
Ogg bytes. Filenames are taken from Evolution, then the stored message, falling
back to the message ID. Embedded resource URIs include the encoded filename:
`whatsapp-media:///<jid>/<messageId>/<filename>`. They identify bytes already
included in `blob`; they are not HTTP download URLs or a separate
`resources/read` endpoint.

An MCP bridge must forward the complete JSON-RPC response, including all
`content` blocks, over either JSON or SSE. A 10 MiB file occupies about
13.33 MiB in base64 before the JSON metadata. Agents can decode `data` or `blob`
to recover the original file. Preview, playback and model understanding depend
on the MCP client's support for that MIME type.

### Clients that omit audio

Some ChatGPT clients replace an MCP audio block with
`<audio content omitted because you do not support audio input>`. This means
the server downloaded the audio, but the client did not expose those bytes to
the model. Native audio metadata now explains how to recover the file.

Use `delivery: "file"` to receive an embedded `resource` for any MIME type,
including audio. For clients that also omit embedded files, use
`delivery: "base64"`. This mode returns **one text block only**, containing
JSON with the metadata above plus:

| Field | Meaning |
| --- | --- |
| `encoding` | `base64` (standard padded base64, no data-URL prefix) |
| `data` | Base64 for this chunk of the original file |
| `offset` | Starting offset in **decoded bytes**, initially 0 |
| `byteLength` | Number of decoded bytes in this chunk |
| `hasMore` | Whether more bytes remain |
| `nextOffset` | Offset to use for the next call; present only when `hasMore` is true |

Example arguments:

```json
{"jid":"<jid from read-messages>","messageId":"<exact audio entry id>","delivery":"base64","offset":0}
```

Decode each chunk **separately**, concatenate the decoded bytes in offset order,
and save them using `filename`. Do not concatenate the base64 strings: a chunk
may have its own padding. Keep the same `jid`, `messageId`, `size` and `sha256`
across calls, continue with `nextOffset` until `hasMore` is false, then verify
the assembled file's size and SHA-256. An offset at or beyond the end is refused
with 416. The optional `limit` is a decoded-byte count: 12 KiB by default,
48 KiB maximum. `offset` and `limit` apply only to base64 delivery.

Each call fetches the attachment on demand; no media cache or download endpoint
is created. Native or embedded delivery is preferable when the client supports
it. Base64 delivery retains the same chat/tool scope, view-once refusal and
10 MiB whole-file limit. It provides the actual recording, not a transcript.
An agent still needs a file/code tool to save bytes and an audio-capable tool
to listen or transcribe. Metadata alone does not reveal the recording's words.

After deploying a change to these tool arguments, refresh the connector's tool
definitions in the client before using `delivery`, `offset` or `limit`.

## Chats addressed by LID (`…@lid`)

WhatsApp addresses a person in one of two ways. The familiar one is a
phone-number JID, `5511999999999@s.whatsapp.net`. The other is a **LID**, such as
`79972425314508@lid`: a per-person alias WhatsApp uses so that group members and
people who never exchanged numbers don't learn each other's phone numbers. **A
LID's digits are not a phone number.** They carry no country code, and dialling
them reaches whoever owns that number, if anyone.

Which form a chat gets is WhatsApp's decision, not this app's. Group members are
usually LIDs, and many 1:1 chats are too, especially in
history imported at pairing. So `list-chats`, the dashboard and the token scope
picker routinely show chats whose identifier ends in `@lid`.

What the connector does with them:

- **Reading and searching** work the same for both forms.
- **Replying** works: `send-text-message` takes the chat's full JID
  (`…@lid`) and the message lands in the existing conversation, stored under the
  LID. The tool description and the server instructions tell the model to pass
  the JID as returned, and never to strip the suffix and send to the digits.
  If it does anyway, a send to digits this account has seen as a LID (as a chat,
  a group sender or an @-mention) is refused with the full JID to use instead.
  Digits it has never seen as a LID — a new contact's phone number — still send.
- **Names** for senders and @-mentions are resolved from the account's contacts
  and from group membership, which knows both forms of each member. A LID it
  cannot resolve stays a raw id rather than being guessed.
- **Phone numbers** are shown as `number` only for chats addressed by phone
  number. A LID chat has no `number`; instead it carries `phoneNumber` in
  `list-chats` (and shows it in the dashboard's Chats table, marked "via LID")
  **when WhatsApp has revealed it**: Evolution keeps the phone-number form as
  `remoteJidAlt` on some live messages in the LID chat. History import never
  carries it, so a LID chat with only imported messages shows no number even
  when the phone itself shows one. A LID seen with more than one number (or a
  number with more than one LID) is left unlinked rather than guessed. Nothing
  else is consulted — not contact names, not the alias's own digits, not data
  from other accounts on the same Evolution server. The chat is still the LID:
  replies and token scope follow its JID, not the number.
- **One person, two chats, shown as one.** Someone who moved from phone-number
  to LID addressing has part of their history under each id. When the two are
  linked as above, `list-chats` and the dashboard's Chats table show one row,
  under the LID, with both ids in `jids`. `read-messages` and `search-messages`
  given either id read both, as one timeline with no duplicates, and search
  labels every hit with one id per person. A token reads only the halves it is
  scoped to and is told, as a count, when part of the conversation is outside
  its scope. A chat with no link says so (`linkUnknown`) where a second part
  could exist. Links are re-read every half hour, so a link revealed by a new
  message can take that long to merge the two rows. The dashboard's Chats
  *card* still shows Evolution's own count, which is not comparable.

What it can't do yet:

- **Tell you the phone number behind every LID.** WhatsApp reveals the link
  only on some live messages, never on imported history, and Evolution has no
  API for Baileys' own mapping. So `phoneNumber` is partial, and the model is
  told its absence means "unknown", not "none". It also needs the message
  database: a connection without one never shows it.
- **Link chats it has no link for.** A LID chat with no revealed number stays
  a separate chat from that person's phone-number chat, if they have one. A
  read of either says the conversation may continue under another id.

**Token scope stays a list of exact chat ids.** A linked person is one row in
the token's chat picker, showing their number and "2 chats". Ticking it allows
both ids, and unticking removes both. A token that holds only one of the two
(one scoped before they were linked, say) shows the row as partly ticked, with
a note. It keeps reaching only that half until you tick the row, and the model
is told part of the conversation is outside its scope. A link never lets a
token reach an id that wasn't ticked.

On a bring-your-own Evolution server with `DATABASE_SAVE_IS_ON_WHATSAPP=true`,
Evolution may resolve a LID to the phone-number JID it has linked it to. For a
token scoped only to the LID chat, sending to that LID is then refused, because
the message would go to the phone-number id. The refusal says so. Ticking the
person's row so both ids are included, or turning the setting off, avoids it.

## Stuck reconnecting (`conflict: replaced`)

The signature, in Evolution's log: `stream errored out` dozens of times a minute
for one instance, each with `reasonNode: {"tag":"conflict","attrs":{"type":"replaced"}}`,
`statusReason: 428` / `440`, and a fresh `CONNECTED TO WHATSAPP` after every one.
Two sockets are logging in with the same credentials and replacing each other.
Evolution 2.3.7 retries a 440 close at once with no backoff, and replaces its
client without ending the old socket, so nothing inside Evolution ends it. The
stored status reads `open` throughout.

**Fix: restart the Evolution service.** On boot it reconnects every account whose
status is `open` or `connecting` with one socket each. Every account drops
briefly; none needs a QR scan. Do it soon: repeated logins on a real number can
get it flagged by WhatsApp, and the log volume can hit Railway's 500 lines a
second cap, which hides every other account's logs.

Reconnect in the app does not help, and the app no longer sends Evolution's
`POST /instance/restart`. On Baileys that route ends the socket and can then
connect a second time itself, which is one way two sockets appear. The dashboard
offers Reconnect only for a connection whose socket is `close`.

The app detects the loop from Evolution's own `"Instance"` row, not from
webhooks (deliveries are unsigned): every socket that opens writes the row. A
connection whose `open` row keeps being freshly written for ten minutes is
marked **Unstable** on the dashboard, and `get-connection-status` returns
`flapping: true`. The web log gets one line naming the instance and the fix,
and with `NUXT_OPS_ALERT_EMAIL` set the operator is mailed straight away.
After the usual ten-minute grace period, everyone who can reach the connection
is emailed (see [alerts.md](alerts.md), which also covers what the hosted
offering tells customers instead). That takes the message database URL
and, with a dedicated role, the `"updatedAt"` grant above.

## Connections never paired are removed after an hour

A WhatsApp connection that nobody pairs within **one hour** of creating it is
deleted automatically, together with any connector tokens on it. While it waits,
it isn't idle. Evolution keeps it `connecting`, generates a fresh QR every few
minutes and prints each one to its log, and reconnects it at every Evolution
restart. On the hosted offering it also counts toward the organization's
connection limit. The pairing screen shows how much time is left.

The `instances:reap-unpaired` task runs every ten minutes. These rules decide
what it deletes:

- **Only connections this app has never seen paired.** The app records the first
  time it sees an account linked (`app.instances.paired_at`). A logout later
  does not clear it, so a connection that was paired and later signed out is
  never removed. Rows that existed before this was added were backfilled from
  alert history and, where Evolution shares the app's database, from Evolution's
  `ownerJid` and stored messages. One case neither the backfill nor the live
  check below can see: a connection signed out *before* upgrading, on a server
  whose database the app has no URL for, that never raised an alert. It looks
  exactly like one nobody paired, and the first run after the upgrade removes
  it. To keep one, add its database URL (**Enable reading**) or pair it again
  first.
- **Re-checked live just before deleting.** If Evolution now reports the account
  `open` or linked, or its database holds messages for it, the connection is
  marked paired and kept. If the check can't reach Evolution or its database,
  the connection is kept and checked again on the next run. A dedicated role
  without the `"Chat"`/`"Contact"` grants above counts as can't-reach, so no
  connection read through such a role is removed until the grants are added.
- **Deleted the same way as the Delete button**: the instance is first removed
  from Evolution, then the row. If this deployment has no admin key for the
  connection's server, the connection is kept, because deleting the row would
  leave the instance generating QRs there with nothing recording it. This applies
  to bring-your-own servers too, using that server's own key.
- Each row is leased while it is checked, so several replicas can run the task.
  Each deletion logs one line with the connection and organization ids. On the
  hosted offering it also writes a `connection.deleted` event with
  `reason: 'unpaired_expired'`.

Telegram connections are not affected. An unlinked Telegram session holds no
socket and polls nothing.

## Importing existing history

WhatsApp hands over past conversations **once**, in a burst it pushes while a
device is being linked. There is no endpoint — here or upstream — that fetches
history afterwards. Evolution exposes `/chat/findMessages`, but that reads
Evolution's own Postgres, not WhatsApp.

Three things have to line up, and two of them have to be true *before* the QR is
scanned:

| | Where | Effect if wrong |
|---|---|---|
| `DATABASE_SAVE_DATA_HISTORIC=true` | evolution service env | Evolution receives the burst and drops it |
| `syncFullHistory: true` | sent at `POST /instance/create` when **Import full history** is ticked on the create form, in `server/utils/instances.ts` | Only the recent slice arrives (`type: 3` below) |
| A fresh device link | scanning the QR | Reconnecting an existing session sends no history |

The first and third are automatic. The second is the owner's choice: **Import
full history** on the create form is **off by default for everyone**, Pro and
self-hosted included, so a new account imports the recent slice unless asked
for more. An account paired without it cannot be backfilled in place — **Import full history** on the
connection's dashboard sets the flag, signs the device out and puts the QR back
up; the import rides in on the re-scan. Nothing already stored is lost. The
re-import can write a second copy of a message Evolution already holds (see
[Reading and searching messages](#reading-and-searching-messages)), but reads and
searches collapse copies by `key.id`, so each message is still reported once.

Watch it land with `pnpm services:logs` while scanning:

```
recv 412 chats, 1180 contacts, 39204 msgs (is latest: false, progress: 34%), type: 2
```

`type: 2` is a full sync, `type: 3` is the recent-only one. Anything but `2` means
`syncFullHistory` never reached the socket.

The connection's page shows it too, to whoever scanned: after the scan it reads
**Importing your WhatsApp history** with message and chat counts climbing, and
moves on to the dashboard once they have stopped changing for about fifteen
seconds (three minutes at most; **Show dashboard now** skips the wait). The
import carries on in Evolution either way, and the dashboard counts catch up.

Caveats worth knowing before you rely on it:

- **Media is fetched on demand.** History import stores the message records.
  Use [`get-whatsapp-media`](#retrieving-media) to fetch an available attachment.
- **Depth is whatever the phone volunteers.** `syncFullHistory` asks for
  everything; it is not a guarantee of everything.
- **Groups come too.** `syncFullHistory` overrides Evolution's group filter, so
  group chats appear in `list-chats` and in the token scope picker.
- **Reads get slower as it grows.** Evolution indexes its `Message` table on
  `instanceId` only; `remoteJid` lives inside a JSONB column with no index.

### Recent history only

With **Import full history** unticked — the default — a connection is created
with `syncFullHistory: false`. On the hosted offering a Free organization cannot
tick it (`app.organizations.recent_history_only`, written by the cloud service;
see [Plans and billing](billing.md)). Baileys then sends
`requireFullSync: false`, and WhatsApp hands over only what it gives any linked
browser — the `type: 3` sync above. Evolution still stores it, since it
persists every history sync type under `DATABASE_SAVE_DATA_HISTORIC`. How far
back that reaches is WhatsApp's choice, not a setting here.

Group chats still sync live and in that slice: with `syncFullHistory` off,
Evolution's group filter falls back to `groupsIgnore`, which instances are
created with off.

The Free limit is enforced in three places, all in
`server/utils/instances.ts`:

- **Create**: the box is locked on the form (`/api/auth/me` carries
  `recentHistoryOnly`), and `provisionWhatsappInstance` answers 402
  `plan_limit` to `fullHistory: true` before anything is provisioned.
- **Import full history** answers 402 `plan_limit`; the dashboard hides it and
  points admins at Billing instead.
- **Pairing**: before the QR poll's `connect`, a connection still carrying
  `syncFullHistory: true` (created while the organization was on Pro) has it
  turned off, at most once a minute per connection. Never the other way:
  upgrading turns nothing on, since full history costs a QR scan and that is the
  owner's call.

It never applies to a bring-your-own Evolution server, and it deletes nothing
already imported. Self-hosted deployments never set it.

Older messages are not fetched later either: reads and searches only query
Evolution's database, and nothing can ask WhatsApp for history after pairing.
So the MCP tools say when the history is partial. `read-messages`,
`search-messages` and `get-connection-status` carry `recentHistoryOnly: true`
when the connection's Evolution settings have `syncFullHistory` off — the
setting its pairing actually used, not the current plan, so an organization that
upgraded but has not re-imported still reads as partial. `read-messages` adds a
`note` once it reaches the oldest stored message, and `search-messages` adds one
on every response. Self-hosted accounts paired before full-history sync existed
report it too, accurately. Read through `recentHistoryOnly()` in
`server/utils/instances.ts`, cached five minutes per connection.

## Bring your own Evolution server

**Self-hosted only.** The hosted service refuses it (422) and doesn't offer the
option: there, any self-signup could point our scheduled tasks at a server they
control. Self-hosted deployments are unaffected.

A WhatsApp connection can be created against a user's own Evolution server: the
create form takes the base URL and that server's `AUTHENTICATION_API_KEY`, and
the app provisions an instance on it exactly as it does on the default server.
Both halves or neither — half a configuration is never completed from this
deployment's own, because sending our global key to a server someone else
controls would hand them every account on ours.

With `NUXT_EVOLUTION_URL` and `NUXT_EVOLUTION_ADMIN_KEY` unset there is no
default server, and supplying one becomes required to create a WhatsApp
connection. Everything else in the app still works.

Server URLs are compared by origin, so a trailing slash on `NUXT_EVOLUTION_URL`
does not reclassify this deployment's own connections as bring-your-own. If a
connection's server has no global key available any more — the variables were
unset, or the row no longer matches the configured server — deleting it still
removes the row and its tokens, and logs the instance left behind on that server.

## ⚠️ WhatsApp pairing burns a real phone number

Scanning the QR binds a real WhatsApp account to an instance. WhatsApp rate-limits
and can ban numbers that pair and unpair repeatedly, or that send unsolicited
messages from a freshly-paired session. **Use a spare SIM, not your primary
number**, and keep test traffic to conversations you control.

Routine restarts must never use `docker compose down -v` — see [Self-hosting](self-hosting.md).
