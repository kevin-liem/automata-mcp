# Using Automata

## Getting started

1. Sign up at your deployment's address (<http://localhost:3000> locally).
2. Create a connection: pick **WhatsApp account**, **Telegram account**,
   **Email (IMAP)** or **PostgreSQL database**, and name it.
3. **WhatsApp:** continue to the QR code and scan it — WhatsApp → Settings →
   Linked devices → Link a device. To use an Evolution server other than this
   app's, tick **Use my own Evolution API server** first (see [Bring your own Evolution server](whatsapp.md#bring-your-own-evolution-server)).
   That option exists only on self-hosted deployments.
   A WhatsApp connection not paired within an hour is deleted with its tokens;
   the pairing screen counts down (see [Connections never paired are removed after an hour](whatsapp.md#connections-never-paired-are-removed-after-an-hour)).
   **Telegram:** on the connection's page press **Show QR code** and scan it —
   Telegram → Settings → Devices → Link Desktop Device. An account with two-step
   verification is then asked for its password, which goes to Telegram and is
   stored nowhere. Chats start syncing as soon as it links.
   **Postgres:** paste a connection string, or fill in host, port, database,
   user, password and SSL mode on the **Parameters** tab, which builds one. It
   is proved by connecting before anything is saved (see
   [Database connections](postgres.md)).
   **Email:** enter the IMAP server and an app password. It is proved by logging
   in before anything is saved, and headers start syncing at once (see
   [Email (IMAP) connections](imap.md)).
4. On the connection's dashboard, create a **New connector token**: a name, an
   expiry (30 days, 90 days — the default — 1 year, or never) and a scope.
5. Add it to Claude. The **How to connect** dialog has the steps for Claude.ai
   (Settings → Connectors → Add custom connector), Claude Code
   (`claude mcp add --transport http <name> <url>`), clients that send an
   `Authorization: Bearer` header, and the MCP Inspector.
   **Cursor** (hosted server only): install the Automata plugin from
   [cursor.directory](https://cursor.directory), or add this repository's
   `mcp.json` entry to your own. It sends the token from the `AUTOMATA_TOKEN`
   environment variable, so set that where Cursor starts — a Cursor opened from
   the dock or start menu may not see variables exported in your shell profile —
   and restart Cursor.

**One connection per connector.** A token is bound to the connection it was
created on, so no tool takes a connection argument, and Claude cannot address the
wrong number or the wrong database. Connect several and give each its own token.

## Organizations and roles

Connections belong to an **organization**, not to a person. Signing up creates
one and makes you its admin; you join someone else's only by accepting an
invitation, and an account belongs to exactly one organization.

- **Admins** manage the organization (**Team** page): invite people, change
  roles, remove members, create and delete connections, assign them, and mint
  or edit tokens for anyone.
- **Members** use the connections assigned to them. They see only their own
  tokens there, and may revoke a token or rotate its secret but never widen its
  scope. Reconnecting, re-pairing and deleting are management, so a member is
  told what is wrong and that an admin can fix it.

An invitation names an email address and can be accepted only by an account
with that address, so a forwarded link is useless to anyone else. The link is
shown once when it is created and can also be emailed (see [Connection alerts](alerts.md)
for SMTP). Accepting moves you out of your current organization, which is
refused while that organization still owns connections or while you are its
only admin with other members left.

Anything that takes away someone's access to a connection — unassigning it,
demoting an admin, removing a member — revokes the tokens they held on it, and
asks first. A connection you cannot see answers 404; one you can see but may not
manage answers 403.

## MCP tools

Every tool is gated twice: by the connection's kind — a Postgres token never sees
a WhatsApp tool, whatever its scope — and by the token's scope. The server also
sends per-kind instructions telling the model how to page and how to read what
comes back.

| Tool | Kind | | What it does |
|---|---|---|---|
| `get-connection-status` | WhatsApp | read | Whether the account is paired and connected (`open`); `flapping` when it reads `open` but keeps reconnecting — shown as **Unstable** on the dashboard, fixed by restarting the Evolution service, not by Reconnect |
| `list-chats` | WhatsApp | read | Conversations in scope, most recently active first, with the `jid` other tools take; says `hasMore` when it returned one page of several. No read/unread status — WhatsApp's read state isn't available to it |
| `read-messages` | WhatsApp | read | One chat, newest first, 1–200 per page (default 50), optional `since` / `until`; reports `hasMore`, `nextPage`, `covered` and `totalMatching` |
| `search-messages` | WhatsApp | read | Messages containing every word of `query`, across chats in scope or one `jid`; optional date range and `fromMe`; up to 100 matches (default 20) |
| `get-whatsapp-media` | WhatsApp | read | Retrieve an image, video, audio recording, document or sticker by chat `jid` and exact `messageId`, up to 10 MiB; defaults to a five-minute download link and metadata, with image previews; explicit native/file/base64 delivery remains available |
| `send-text-message` | WhatsApp | **write** | Send text to a number in international format; a refusal (e.g. a number not on WhatsApp) comes back with WhatsApp's reason |
| `get-telegram-status` | Telegram | read | Whether the account is linked and online, who it is signed in as, and how far sync has got |
| `list-telegram-chats` | Telegram | read | Synced chats in scope — private, groups, supergroups, channels — most recently active first, with the `chatId` other tools take; 1–200 per page (default 100) |
| `read-telegram-messages` | Telegram | read | One chat, newest first, with the same paging envelope as `read-messages`; optional forum `topicId`; says when older history was never synced |
| `search-telegram-messages` | Telegram | read | Messages containing every word of `query` (text and captions), across chats in scope or one `chatId` |
| `send-telegram-message` | Telegram | **write** | Send plain text (≤ 4096 chars) to exactly one of `chatId` or `username` — an @username, a t.me link or a phone number |
| `get-mailbox-status` | Email | read | Which mailbox, whether its sync works, when it last ran, and which folders are still backfilling |
| `list-mail-folders` | Email | read | Folders in scope with synced and unread counts; skipped folders (All Mail, Junk, Trash) marked `synced: false` |
| `list-emails` | Email | read | Headers newest first from one folder or all in scope, 1–100 per page (default 25); filters for date, unread, flagged, attachments |
| `search-emails` | Email | read | `from`, `to`, `subject` against synced headers and `text` through the mail server's own search; filters for date, unread, attachments; 1–100 per page (default 25) |
| `read-email` | Email | read | One email's headers, body as plain text (fetched live, never stored) and attachment list; `maxChars` 500–100 000 (default 20 000), continued with `offset` |
| `get-email-attachment` | Email | read | One attachment, fetched live: images as images, text as text (clipped at 100 000 chars, reported as `truncatedAtChars`), other files embedded; 10 MB cap by default |
| `create-email-draft` | Email | **write** | Saves an unsent plain-text draft in the Drafts folder, optionally threaded as a reply; never sends |
| `get-database-info` | Postgres | read | Server version, database, connecting role, and what this token is scoped to |
| `list-tables` | Postgres | read | Tables in scope, filterable by schema and name, paged (1–500, default 100) |
| `describe-table` | Postgres | read | Columns, keys, constraints, indexes and comments for one table |
| `run-query` | Postgres | read | One `SELECT` / `WITH` / `VALUES` / `TABLE` in a read-only transaction; pages of `maxRows` rows (≤ 1000, default 200) walked with `page`; cells clipped at 2000 chars unless `fullValues`; 10 s timeout by default, 120 s max, and the query is cancelled on the database if the client disconnects first; `explain: true` returns the query plan instead, without running it |
| `run-statement` | Postgres | **write, destructive** | One `INSERT` / `UPDATE` / `DELETE` / `MERGE`; rolled back whole if it would change more than `maxRows` (default 100, no ceiling); no `WHERE` refused without `allowWholeTable`; 15 s timeout by default, 60 s max |

`read-messages` and `search-messages` leave reactions out unless called with
`includeReactions: true`, and say so with `reactionsExcluded`.

Limits and options worth knowing:

- `search-messages` and `search-telegram-messages` need a `query` of at least
  two characters, as does the `text` of `search-emails`. Both message searches
  return up to 100 matches (default 20).
- `read-telegram-messages` leaves deleted and service messages (joins, pins,
  title changes) out unless called with `includeDeleted: true` or
  `includeService: true`, and counts what it left out as `deletedExcluded` and
  `serviceMessagesExcluded`. A group later upgraded to a supergroup names the
  new chat in `migratedTo`.
- `read-email` fetches at most 2 MB of a body from the mail server; anything
  past that is cut before `maxChars` applies.
- `run-query` and `run-statement` take a `sql` of at most 20 000 characters.

## Scoping a token

A token is narrowed on independent axes, set when it is created and editable from
the connection's dashboard. Which axes appear depends on the kind:

- **Actions** (every kind) — all tools, or a chosen few, listed from the
  connection's own kind. Enforced by refusing to register the others for that
  request, so a tool outside scope is not merely hidden from the tool list:
  calling it fails. A new Postgres or Email token starts read-only — the read
  tools ticked, `run-statement` or `create-email-draft` not.
- **Chats** (WhatsApp and Telegram) — all conversations, or an allowlist. `list-chats` returns
  only allowed conversations; `read-messages` and `send-text-message` refuse
  anything else, naming the chat so the assistant can explain why.
  `search-messages` does both: asked for a chat outside scope it refuses by name,
  while an unrestricted search is narrowed to the allowed chats — out-of-scope
  messages are excluded by the query itself, not filtered out after being read.
  **Telegram** works the same way through its own tools, with chats named by
  `chatId`; a send to an @username is resolved first and then checked against
  the allowlist, so a name cannot reach a chat the id could not.
- **Folders** (Email) — all folders, or an allowlist, stored on the chat axis.
  Listings and searches are narrowed in SQL; reading an email or fetching an
  attachment from a folder outside it is refused by name. An email filed in
  several folders is reachable only through a copy in an allowed one. Saving a
  draft needs the Drafts folder in the allowlist.
- **Tables** (Postgres) — every table the connecting role can read, or an
  allowlist. `list-tables` and `describe-table` apply it in their own SQL, so a
  table outside it is neither listed nor described. `run-query` and
  `run-statement` check the statement's query plan before a row is read and
  refuse anything that touches a table outside it. Names match case-sensitively
  (`public.Orders` is not `public.orders`), and allowing a partitioned table
  allows its partitions. What this does and does not protect against is in
  [Database connections](postgres.md).

The chat picker lists conversations Evolution has recorded — the history imported
at pairing, plus everything since. An account paired before full-history sync was
switched on shows only the latter until it is re-imported. Either way a number
that has never messaged you can be added directly; it is checked against WhatsApp
before it is accepted.

Scope is read fresh on every request, so **editing a token's scope takes effect
immediately and does not reissue it**. The connector already configured in Claude
keeps working; only what it can reach changes. The same **Edit** dialog renames
the token, which likewise leaves the connector untouched.

A scoped send refuses when it cannot verify the recipient — if the account is
disconnected, the message is not sent rather than sent unchecked.

## Tokens that can send

When a WhatsApp or Telegram token is allowed to send, the token dialog warns that
the assistant sends from the real account: high volume, messaging people who never
messaged you, or repeating the same text can get the account restricted or
banned by WhatsApp or Telegram. Keep sending low-volume and scope the token to the
chats it needs.

The same dialog offers an optional **disclaimer**, off by default. Turned on, it
starts as "Sent using DOPE" and can be reworded (up to 200 characters). The
server appends it on its own line to every message that token sends. The model
isn't asked to add it, so it can't forget it or change the wording. The tool's
response names the appended text in `disclaimerAppended`. On Telegram the
disclaimer counts toward the 4096-character limit, and a message that goes over
it is refused with the number of characters to cut. The disclaimer is per
token, and admins can edit or remove it in the token's Edit dialog. A token that
can't send stores none.

The token is shown exactly once — only its SHA-256 hash is stored. Lost tokens
are replaced, not recovered. Revoking one takes effect immediately, and revoking
stays available while an account is disconnected or a database is unreachable.

**Which clients use a token.** Under each token's name the list shows the MCP
clients that have connected with it, as they name themselves when a session
starts, for example `claude-ai 0.1.0 · Cursor 1.7`. Click the line for each
client's version, protocol version, user agent, when it was first seen, its last
session and how many sessions it has started. "Last session" is when a client
last connected; **Last used** is still the last tool call. The newest 20 clients
are kept per token. A member sees this for their own tokens, an admin for all of
them.

A client whose name first appears more than a day after the token's first client
gets a **New client** label for two weeks. If you don't recognise it, issue the
token a new secret. It's a hint only: a client can call itself anything, so a
token without the label isn't proven safe, and nothing about access depends on
these names.

Inspect the endpoint by hand with:

```bash
pnpm dlx @modelcontextprotocol/inspector
```

Point it at `http://localhost:3000/mcp/<token>`, or at `http://localhost:3000/mcp`
with an `Authorization: Bearer <token>` header. On a deployment, the same paths
under its `NUXT_PUBLIC_APP_URL`.

## Telemetry

Every connector tool takes an optional `reason` argument: one sentence from
Claude saying why it is making the call, for example *"User asked to find
invoices from a vendor received last week and total them."* MCP never sends the
user's prompt to the server, so this is the closest an organization can get to
knowing what its connectors are used for. It is still Claude's own account,
written by the model, and not the prompt.

When an organization's telemetry is on, each tool call is stored for **30
days** with the tool's name, whether it worked, the reason (clipped to 300
characters, or none if Claude gave none) and the client's user agent. Click a token's **Last
used** date to see them, newest first. A member sees the calls of their own
tokens, an admin those of every token in the organization.

- **Who decides.** Tool-call recording is off by default on all plans. An
  organization admin can set `recordToolCalls` via `PATCH /api/org`.
- **What it's not.** A reason can mention what someone asked about, and a
  prompt-injected message can make Claude write anything there. So reasons are
  kept only in this app's database, shown as plain text, never written to logs,
  analytics or account events, never returned to Claude over MCP, and never used
  for access, limits or billing.
- **Turning it off** stops collection. What was already stored is deleted
  when its 30 days are up.
