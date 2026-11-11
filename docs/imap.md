# Email (IMAP) connections

An IMAP connection gives Claude read access to one mailbox: it can list
folders, list and search emails, read an email's text, and fetch its
attachments. When a token is granted it, Claude can also save a plain-text
draft in the mailbox's Drafts folder for you to send yourself. It cannot send,
delete, move or mark mail.

## Setting one up

Pick **Email (IMAP)** when creating a connection and fill in the server, port,
security, username and password. The presets fill in the server for Gmail,
iCloud, Fastmail, Zoho and Yahoo. The credentials are checked by logging in
before anything is saved, so a wrong password fails the create rather than
leaving a connection that never syncs.

- **Use an app password.** Gmail (with 2-Step Verification on), iCloud, Fastmail,
  Yahoo and Zoho issue passwords meant for exactly this. You can revoke one
  without changing your main password.
- **Microsoft 365 and Outlook.com cannot be connected.** Microsoft no longer
  accepts passwords over IMAP and requires OAuth, which this connection does not
  support.
- **There is no unencrypted option.** Choose **TLS** (usually port 993) or
  **STARTTLS** (usually 143). STARTTLS is enforced: a server that does not
  upgrade the connection is refused, rather than sent the password in clear.
  Certificates are verified against the host name.

**Change credentials** on the connection's page replaces them, proved the same
way. Every connector token keeps working. If the new login is a *different*
mailbox, everything synced from the old one is deleted first.

## What is stored and what is not

The connection is a hybrid:

| | Where it comes from | Stored here? |
|---|---|---|
| Folders, sender, recipients, subject, date, read/flagged state, threading ids | Synced every two minutes | Yes, about 1 KB per email |
| Attachment names, types and sizes | Synced, from the message structure | Yes |
| Email body | Fetched from the mail server when `read-email` asks | **No** |
| Attachment content | Fetched from the mail server when `get-email-attachment` asks | **No** — not in the database, not on disk |
| Searching inside email text | Passed to the mail server's own search | No |

Storage therefore stays small whatever your mail weighs, and the bodies and
files stay on your mail server. Reading through this connection opens folders
read-only and fetches with `BODY.PEEK`, so **reading an email does not mark it
read** in your mail client.

The synced headers live in the app database (`app.mail_folders`,
`app.mail_messages`, `app.mail_sync_state`) and go when the connection is
deleted. Like every credential on a connection, the mailbox password is stored
in clear in the app database and its backups.

## What syncs

- **Every folder except All Mail, Junk and Trash.** Gmail's All Mail would hold
  every message a second time. Skipped folders still appear in
  `list-mail-folders` with `synced: false`, so their existence is not hidden.
  A folder that cannot hold mail (a parent such as `Archive` above
  `Archive/2024`) is listed the same way.
- **New mail** within two minutes, and changes to read and flagged state. On
  servers with CONDSTORE the server reports what changed; on others the newest
  500 emails per folder are re-checked each run.
- **Deleted mail** is removed at least every tenth minute.
- **Older mail is backfilled** newest first, 500 emails per folder per run, up to
  `NUXT_IMAP_BACKFILL_DAYS` (default 365) back and `NUXT_IMAP_BACKFILL_MAX`
  (default 50 000) emails per folder. A folder that stopped at a limit says so
  (`history.stopped`), and the tools tell Claude that reaching the end of a
  listing then means "oldest synced email", not "oldest email".
- **A folder the server renumbers** (its UIDVALIDITY changes, as when a folder is
  deleted and recreated) is synced again from scratch. An email id issued before
  that answers "list the folder again" rather than returning a different message.
- **One email in several folders** — Gmail labels work this way — is listed once,
  with every folder in `folders`.
- **An email whose headers cannot be stored** (malformed text the database
  refuses) is listed by date with no subject, sender or attachments instead of
  stalling the rest of the folder; its body is still readable.

The dashboard shows the sync's state: when it last succeeded, how far each folder
has got, and why it is failing if it is. **A refused password stops the sync**
until the credentials are changed or **Sync now** is pressed, since retrying a
refused login every two minutes is how providers lock accounts. Listings say when
the sync is behind, so Claude does not present a stale inbox as current.

The mail server's replies are size-capped (1 MiB per line, literals just above
the attachment cap) and connecting plus logging in must finish within 60
seconds; a server that exceeds either fails that run rather than affecting
anyone else's.

The sync runs in the web process and is safe with several replicas: each mailbox
is claimed with a lease in the database, so only one replica syncs it at a time.
A process that stops mid-sync holds that lease for up to ten minutes, during
which **Sync now** reports that a sync is already running.

## The tools

| Tool | What it does |
|---|---|
| `get-mailbox-status` | Which mailbox, whether the sync works, when it last ran, which folders are still backfilling or stopped at a limit |
| `list-mail-folders` | Folders in scope, INBOX first, with synced and unread counts |
| `list-emails` | One page of headers, newest first, from one folder or every synced folder in scope; filter by date, unread, flagged, attachments |
| `search-emails` | `from`, `to`, `subject` (synced headers) and `text` (the mail server's own search), combined with AND |
| `read-email` | Headers, the body as plain text (HTML converted), the attachment list; long bodies in pieces with `offset` |
| `get-email-attachment` | One attachment, whole: images as images, text files as text, anything else (PDFs included) as an embedded file |
| `create-email-draft` | **Write.** Saves an unsent plain-text draft in the Drafts folder; see [Drafts](#drafts) |

The first six only read. Pages use the same envelope as the WhatsApp and Telegram
readers: `hasMore`, `nextPage`, `totalMatching`, `covered` and a `note` when
something was left out.

**Body search depends on your server.** Most IMAP servers match substrings;
Gmail matches whole words using its own search syntax. The search covers at most
20 folders within 25 seconds, and any folder it did not reach is named in
`bodySearch.skipped`.

**Bodies are fetched up to 2 MiB** from the server; a longer one is cut there
and `read-email` says so.

**Attachments are capped** at `NUXT_IMAP_ATTACHMENT_MAX_BYTES` (default 10 MiB).
A larger file is refused with its size before anything is downloaded, using the
size the server reports, and the cap is enforced again on the bytes. Only parts
the synced message lists as attachments can be fetched.

## Drafts

`create-email-draft` writes one message into the mailbox's Drafts folder,
flagged as a draft and as read, and does nothing else. **It does not send
mail and cannot**: the connection has no SMTP credentials. The draft waits in
your mail client until you send it, edit it or delete it.

- **Off by default for new tokens.** A new mail token starts with the six read
  tools ticked and `create-email-draft` not. Tokens created before this tool
  existed with **all** actions allowed get it, as "all" means; tokens with a
  chosen list of actions do not.
- **The folder is not Claude's choice.** It is the folder your server marks as
  Drafts, or failing that the one folder named "Drafts". A mailbox with neither,
  or with more than one, is refused rather than guessed at.
- **Folder scope applies.** A token limited to certain folders must include the
  Drafts folder; otherwise the call is refused naming it.
- **Plain text only, no attachments.** The sender is the login address, so a
  connection whose username is not an email address cannot save drafts.
- **Replies are threaded.** Given the `emailId` of the email being answered,
  the draft carries its `In-Reply-To` and `References` headers, the subject
  defaults to `Re: …` and the recipient to the original sender (to its
  recipients, when you sent the original). Reply-To is not synced, so it is not
  followed. The original text is not quoted unless Claude includes it.
- The draft appears in `list-emails` after the next sync; saving one starts a
  sync straight away.

## Scoping a token

An IMAP token is scoped by **folder**, on the same axis WhatsApp and Telegram
tokens use for chats. A token limited to `Clients` lists, searches and reads only
emails filed there: an email that is also in INBOX is reachable through its
`Clients` copy only, and asking for a folder outside scope is refused by name.

## Outbound host guard

The mail server is an address a user chose, so it goes through the same guard as
a database connection string (the "Outbound host guard" paragraph of [Database connections](postgres.md)):
private and loopback addresses are refused unless `NUXT_ALLOW_PRIVATE_TARGETS=true`,
this deployment's own backends are always refused, and the address approved is
the one dialled. A cached connection's host is re-checked every minute.

## Settings

| Variable | Default | |
|---|---|---|
| `NUXT_IMAP_BACKFILL_DAYS` | `365` | How far back the header sync reaches, per folder |
| `NUXT_IMAP_BACKFILL_MAX` | `50000` | Most emails synced per folder |
| `NUXT_IMAP_ATTACHMENT_MAX_BYTES` | `10485760` | Largest attachment `get-email-attachment` fetches |

All three are optional and set on the web service.
