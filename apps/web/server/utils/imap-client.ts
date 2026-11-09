import { isIP } from 'node:net'
import { ImapFlow } from 'imapflow'
import type { ImapFlowError, MessageStructureObject } from 'imapflow'
import type { AppInstance } from './app-db'
import { htmlToText } from './html-text'

/**
 * Everything that speaks IMAP to a user's mail server: opening a connection,
 * proving credentials, the three things fetched live — a message body, an
 * attachment, a server-side body search — and the one write, appending a
 * draft. The sync (imap-sync.ts) opens its own connections through `openImap`
 * too, so the host guard and TLS rules live once.
 *
 * Rules easy to undo:
 *
 * - **Every connection goes through `assertPublicTarget` and dials the approved
 *   address**, with the original hostname as SNI and the certificate checked
 *   against it. A mail host is a user-chosen outbound target exactly as a DSN
 *   is, so `imap.example.com` resolving to this deployment's Postgres is the
 *   same attack.
 * - **No plaintext.** `starttls` sets `doSTARTTLS: true`, which makes the
 *   upgrade mandatory — imapflow's default would carry on in cleartext when the
 *   server (or someone on the path) omits STARTTLS from its capabilities.
 * - **Every mailbox is opened read-only (EXAMINE), and parts are fetched with
 *   BODY.PEEK.** Reading a message through this connector must not mark it read
 *   in the user's mail client.
 * - **The only write is `appendDraft`: one APPEND, on its own connection.** It
 *   selects no mailbox, so nothing here ever opens one read-write, and it never
 *   stores flags on, moves, copies or expunges an existing message. Sending is
 *   not something this file can do — there is no SMTP here.
 * - **An `error` listener on every client.** imapflow emits `error` on a dropped
 *   socket; an EventEmitter with no listener turns that into an uncaught
 *   exception that takes the whole server down.
 * - **Attachments are never stored.** `downloadAttachment` streams into memory,
 *   capped, and hands the bytes to the caller; nothing here writes to disk or
 *   the database.
 */

export type ImapSecurity = 'tls' | 'starttls'

export interface ImapTarget {
  host: string
  port: number
  security: ImapSecurity
  user: string
  password: string
}

/**
 * One attachment as BODYSTRUCTURE describes it. The bytes stay on the server.
 * A type alias rather than an interface: it is written to a `jsonb` column,
 * and postgres.js's parameter type wants the implicit index signature only an
 * alias has.
 */
export type MailAttachment = {
  /** The IMAP part id (`2`, `1.3`). The only way to ask for this attachment. */
  part: string
  filename?: string
  mimeType: string
  /** Decoded size estimate in bytes, from the encoded size the server reports. */
  size?: number
  /** `true` for a part shown inside the message (a pasted image), not attached. */
  inline?: boolean
  contentId?: string
}

/** Where a message's readable text lives, and what else it carries. */
export interface MessageParts {
  textPart?: string
  htmlPart?: string
  attachments: MailAttachment[]
}

const CONNECT_TIMEOUT_MS = 15_000
/**
 * Everything `openImap` waits for — TCP, TLS or STARTTLS, greeting, login and
 * the folder LIST connect() issues — end to end. Generous: a real server does
 * all of it in seconds, even with thousands of folders.
 */
const OPEN_DEADLINE_MS = 60_000
/** What a body fetch may pull over the wire before it is cut. */
const BODY_MAX_BYTES = 2 * 1024 * 1024
/**
 * The longest single response line the server may send. Every SEARCH answer is
 * one line, and imapflow turns it into one object per number, about 125 bytes
 * of heap per byte on the wire. Its own default is 1 GiB, so a mail server a
 * tenant named could exhaust the heap of the process every tenant shares with
 * one answer (GHSA-mqp8-94pq-4pwx). 1 MiB holds about 95,000 UIDs, and the
 * sync asks in UID windows small enough to stay under it (imap-sync.ts).
 */
const MAX_LINE_BYTES = 1024 * 1024

/** The largest attachment `get-email-attachment` returns. Operator setting. */
export function attachmentMaxBytes(): number {
  const value = Number(useRuntimeConfig().imapAttachmentMaxBytes)
  return Number.isFinite(value) && value > 0 ? value : 10 * 1024 * 1024
}
/** How long a server-side body search may take across every folder. */
const SEARCH_BUDGET_MS = 25_000
const SEARCH_MAX_FOLDERS = 20

/** The mailbox a row points at, or undefined for a row that holds none. */
export function imapTargetOf(instance: AppInstance): ImapTarget | undefined {
  const { imap_host: host, imap_port: port, imap_security: security, imap_user: user, imap_password: password } = instance
  if (!host || !port || !user || !password) return undefined
  if (security !== 'tls' && security !== 'starttls') return undefined
  return { host, port, security, user, password }
}

/**
 * Who a mailbox is, for noticing that new credentials name a different one.
 * Synced headers belong to the mailbox they were read from; a change of
 * identity deletes them rather than mixing two people's mail under one row.
 */
export function imapIdentity(target: Pick<ImapTarget, 'host' | 'user'>): string {
  return `${target.user.trim().toLowerCase()}@${target.host.trim().toLowerCase()}`
}

/**
 * Open and log in. The caller owns the client and must `logout()` it.
 *
 * Throws the raw imapflow error; `describeImapError` turns it into something a
 * person or a model can act on.
 */
export async function openImap(
  target: ImapTarget,
  label = 'Mail server',
  options: { signal?: AbortSignal } = {},
): Promise<ImapFlow> {
  const { address } = await assertPublicTarget(target.host, target.port, label)

  // A literal is buffered whole before any caller-side cap applies, and the
  // download caps (BODY_MAX_BYTES, the attachment cap) cut only what reaches
  // the caller. Downloads ask in 64 KiB pieces, so this only has to clear the
  // largest single part a server that ignores partial fetches might send: the
  // attachment cap (+1, how readAttachment notices an oversized part) or the
  // body cap. Read per call: useRuntimeConfig needs the Nitro runtime.
  const maxLiteral = Math.max(attachmentMaxBytes() + 1, BODY_MAX_BYTES) + 64 * 1024

  const client = new ImapFlow({
    host: address,
    port: target.port,
    secure: target.security === 'tls',
    // Mandatory upgrade, never "if offered" — see the header.
    ...(target.security === 'starttls' && { doSTARTTLS: true }),
    // Dialled by address, so the hostname has to be carried for SNI and for
    // certificate verification. An IP literal has nothing to send.
    ...(!isIP(target.host) && { servername: target.host }),
    tls: { rejectUnauthorized: true, ...(!isIP(target.host) && { servername: target.host }) },
    auth: { user: target.user, pass: target.password },
    clientInfo: { name: 'Automata MCP' },
    logger: false,
    // Nothing here waits for push; an IDLE left running would hold the
    // mailbox lock the next request needs.
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 120_000,
    // Past these imapflow fails the stream (LineTooLarge, LiteralTooLarge,
    // ResponseTooLarge) instead of buffering and parsing what the server sent.
    maxLineLength: MAX_LINE_BYTES,
    maxLiteralSize: maxLiteral,
    maxResponseSize: maxLiteral + MAX_LINE_BYTES,
  })
  client.on('error', (error: ImapFlowError) => {
    console.error(`[imap] connection to ${target.host} failed (${error.code ?? 'error'})`)
  })

  // The wall-clock bound on connect(), enforced by closing the client, which
  // rejects connect() through imapflow's own teardown. Neither timeout above
  // is one: `connectionTimeout` and `greetingTimeout` end at the greeting,
  // and `socketTimeout` is an idle timer every received byte resets. So a
  // server that logs in and then answers the LIST connect() issues with an
  // untagged line a second, and never the tagged completion, held connect()
  // open for ever (GHSA-rv5g-x6rm-cvh5) — and no caller could close a client
  // it had not been handed yet. `signal` lets a caller with its own deadline,
  // the sync's watchdog, cut it shorter.
  let cutOff = false
  const cut = () => {
    cutOff = true
    client.close()
  }
  const timer = setTimeout(cut, OPEN_DEADLINE_MS)
  options.signal?.addEventListener('abort', cut, { once: true })
  try {
    if (options.signal?.aborted) cut()
    await client.connect()
    // close() settles every pending step, but should connect() still resolve
    // on a client already closed, it must not be handed out as a live one.
    if (cutOff) throw openTimedOut(target)
  }
  catch (error) {
    client.close()
    throw cutOff ? openTimedOut(target) : error
  }
  finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cut)
  }
  return client
}

/** Coded so `describeImapError` reads it as `timeout`. */
function openTimedOut(target: ImapTarget): Error {
  return Object.assign(new Error(`Opening ${target.host}:${target.port} did not finish in time`), { code: 'OPEN_TIMEOUT' })
}

/** Log out, falling back to dropping the socket. Never throws. */
export async function closeImap(client: ImapFlow): Promise<void> {
  try {
    await client.logout()
  }
  catch {
    client.close()
  }
}

/**
 * Prove a mailbox before it is stored: guard, connect, log in, list folders.
 * Answers 422 with an explanation, so a typo is a failed create rather than a
 * row that looks connected and syncs nothing.
 */
export async function probeImapConnection(target: ImapTarget): Promise<{ folders: number }> {
  let client: ImapFlow | undefined
  try {
    client = await openImap(target)
    const folders = await client.list()
    return { folders: folders.length }
  }
  catch (cause) {
    // A host-guard refusal is already a 422 written for the user.
    if ((cause as { statusCode?: number })?.statusCode) throw cause
    const described = describeImapError(cause)
    console.error(`[imap] probe of ${target.host}:${target.port} failed (${described.code})`, cause)
    throw createError({ statusCode: 422, message: described.message, data: { code: described.code } })
  }
  finally {
    if (client) await closeImap(client)
  }
}

export interface DescribedImapError {
  /** Short and stable: what `mail_sync_state.last_error_code` stores. */
  code: string
  auth: boolean
  /** For a person. Never the server's own text, which can echo the login. */
  message: string
}

export function describeImapError(cause: unknown): DescribedImapError {
  const error = (cause ?? {}) as ImapFlowError
  // A failed write to the app database (postgres.js's PostgresError, whose
  // `code` is a SQLSTATE like 21000) is ours, not the mail server's. Passed
  // through as `error.code` it read as "Could not reach the mail server
  // (21000)" and sent the user checking a server that was answering fine.
  const pg = cause as { name?: string, severity_local?: unknown } | undefined
  if (pg?.name === 'PostgresError' || typeof pg?.severity_local === 'string') {
    return { code: 'internal', auth: false, message: imapErrorMessage('internal') }
  }
  const code = error.authenticationFailed
    ? 'auth'
    : error.tlsFailed || /CERT|SSL|TLS/i.test(error.code ?? '')
      ? 'tls'
      : /TIMEOUT/i.test(error.code ?? '')
        ? 'timeout'
        : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
          ? 'dns'
          : error.code === 'LineTooLarge' || error.code === 'LiteralTooLarge' || error.code === 'ResponseTooLarge'
            ? 'too_large'
            : error.code ?? 'connection failed'
  return { code, auth: code === 'auth', message: imapErrorMessage(code) }
}

/**
 * The words for a stored error code. Kept apart from `describeImapError` so
 * the dashboard can explain a code the sync stored minutes ago.
 */
export function imapErrorMessage(code: string): string {
  switch (code) {
    case 'auth':
      return 'The mail server refused the username or password. Gmail, iCloud, Fastmail, Yahoo and Zoho '
        + 'need an app password here rather than the account password; Microsoft 365 and Outlook.com no '
        + 'longer accept passwords over IMAP at all.'
    case 'tls':
      return 'Could not establish TLS with the mail server. Check the port and security setting '
        + '(993 with TLS, or 143 with STARTTLS), and that the server\'s certificate is valid for this host name.'
    case 'timeout':
      return 'The mail server did not answer in time.'
    case 'dns':
      return 'The mail server\'s host name does not resolve.'
    case 'internal':
      return 'The mail server answered, but storing what it sent failed on our side. '
        + 'The server log has the cause; the sync retries every two minutes.'
    case 'host_refused':
      return 'The mail server\'s address is not one this deployment may connect to.'
    case 'too_large':
      return 'The mail server sent a reply larger than this connector accepts, and the connection was closed.'
    default:
      return `Could not reach the mail server (${code}).`
  }
}

// ── live connection, shared per connection row ────────────────────────────

function liveKey(instance: AppInstance) {
  return `imap:${instance.id}`
}

/**
 * The cached connection used to fetch bodies, attachments and body searches
 * for one mailbox. The sync never uses it, so a long backfill cannot hold the
 * mailbox a tool call is waiting on.
 *
 * Two calls arriving at a cold cache share one login: `keyedResource` runs
 * one build per key and credential and has every other caller await it.
 */
export async function imapFor(instance: AppInstance): Promise<ImapFlow> {
  const target = requireTarget(instance)
  const key = liveKey(instance)
  const secret = [target.host, target.port, target.security, target.user, target.password].join('\0')

  const acquire = () => keyedResource<ImapFlow>(key, secret, {
    build: () => openImap(target),
    destroy: closeImap,
    reguard: async () => {
      await assertPublicTarget(target.host, target.port, 'Mail server')
    },
  })

  let client: ImapFlow
  try {
    client = await acquire()
    // Mail servers drop idle connections; a cached client can be closed by
    // the time it is asked for. Rebuild once rather than failing the call.
    if (!client.usable) {
      await closeKeyedResource(key)
      client = await acquire()
    }
  }
  catch (cause) {
    throw liveFailure(instance, cause, 'connect to the mail server')
  }
  return client
}

export async function closeImapFor(instance: Pick<AppInstance, 'id'>): Promise<void> {
  await closeKeyedResource(`imap:${instance.id}`)
}

function requireTarget(instance: AppInstance): ImapTarget {
  const target = imapTargetOf(instance)
  if (target) return target
  console.error(`[imap] connection ${instance.id} has no complete mailbox credentials`)
  throw createError({ statusCode: 500, message: 'This mail connection has no credentials stored.' })
}

/**
 * A handled error for a live read, logged here because Nitro does not log a
 * deliberate `createError`. 503 rather than 4xx: the caller's request was
 * fine, the mail server was not.
 */
function liveFailure(instance: AppInstance, cause: unknown, action: string) {
  if ((cause as { statusCode?: number })?.statusCode) return cause
  const described = describeImapError(cause)
  console.error(`[imap] could not ${action} for connection ${instance.id} (${described.code})`, cause)
  return createError({
    statusCode: 503,
    message: `Could not ${action}: ${described.message}`,
    data: { code: described.code },
  })
}

/**
 * Run `fn` with `path` open read-only, after checking it is still the folder
 * the row was synced from. A changed UIDVALIDITY means the server renumbered
 * the folder, so a stored UID may now name a different message — answering
 * with it would show one message's body under another's headers.
 */
async function withFolder<T>(
  instance: AppInstance,
  path: string,
  uidvalidity: string | undefined,
  action: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  // One retry, on a fresh connection, when the cached one turns out to be
  // dead. Servers end sessions without warning — an idle timeout, or Dovecot
  // closing a session whose selected folder was deleted elsewhere — and
  // `usable` can still read true until the close is processed.
  for (let attempt = 0; ; attempt++) {
    try {
      return await inFolder(instance, path, uidvalidity, fn)
    }
    catch (cause) {
      if (attempt === 0 && isDropped(cause)) {
        await closeImapFor(instance)
        continue
      }
      if ((cause as ImapFlowError)?.mailboxMissing) {
        throw createError({ statusCode: 410, message: `The folder "${path}" no longer exists on the mail server.` })
      }
      throw liveFailure(instance, cause, action)
    }
  }
}

async function inFolder<T>(
  instance: AppInstance,
  path: string,
  uidvalidity: string | undefined,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = await imapFor(instance)
  const lock = await client.getMailboxLock(path, { readOnly: true, acquireTimeout: 20_000 })
  try {
    const mailbox = client.mailbox
    if (uidvalidity !== undefined && mailbox && String(mailbox.uidValidity) !== uidvalidity) {
      throw createError({
        statusCode: 410,
        message: `The mail server renumbered the folder "${path}" since it was synced, so this email id no longer `
          + 'identifies a message. List the folder again for current ids.',
      })
    }
    return await fn(client)
  }
  finally {
    lock.release()
  }
}

/** The connection, not the request, failed: worth one more try on a new one. */
function isDropped(cause: unknown): boolean {
  const code = (cause as ImapFlowError)?.code
  return code === 'NoConnection' || code === 'EConnectionClosed' || code === 'StateLogout'
    || code === 'ECONNRESET' || code === 'EPIPE'
}

// ── bodies and attachments ─────────────────────────────────────────────────

/**
 * Where the text and the attachments are, read from BODYSTRUCTURE alone.
 *
 * The first `text/plain` and first `text/html` that are not attachments are
 * the body; everything else that is a leaf — files, inline images, forwarded
 * messages (`message/rfc822`, kept whole rather than walked into) — is an
 * attachment. A non-multipart message's only part is `1`, which imapflow
 * leaves unnumbered.
 */
export function messagePartsOf(structure: MessageStructureObject | undefined): MessageParts {
  const out: MessageParts = { attachments: [] }
  if (!structure) return out

  const visit = (node: MessageStructureObject, root: boolean) => {
    const type = cleanText(node.type)?.toLowerCase() ?? 'application/octet-stream'
    if (type.startsWith('multipart/') && node.childNodes?.length) {
      for (const child of node.childNodes) visit(child, false)
      return
    }
    const part = node.part ?? (root ? '1' : undefined)
    if (!part) return

    const disposition = node.disposition?.toLowerCase()
    const filename = cleanText(node.dispositionParameters?.filename ?? node.parameters?.name)
    const attached = disposition === 'attachment' || Boolean(filename)

    if (!attached && type === 'text/plain' && !out.textPart) {
      out.textPart = part
      return
    }
    if (!attached && type === 'text/html' && !out.htmlPart) {
      out.htmlPart = part
      return
    }
    const contentId = cleanText(node.id)
    out.attachments.push({
      part,
      mimeType: type,
      ...(filename && { filename }),
      ...(node.size !== undefined && { size: decodedSize(node.size, node.encoding) }),
      ...(disposition === 'inline' && { inline: true }),
      ...(contentId && { contentId: contentId.replace(/^<|>$/g, '') }),
    })
  }

  visit(structure, true)
  return out
}

function decodedSize(encoded: number, encoding: string | undefined): number {
  return encoding?.toLowerCase() === 'base64' ? Math.floor(encoded * 3 / 4) : encoded
}

/**
 * What the database can hold, from text an outside sender chose: no NUL bytes,
 * which Postgres `text` refuses, and no unpaired UTF-16 surrogate, which
 * `jsonb` refuses (22P02) — a UTF-16 encoded word or RFC 2231 parameter can
 * decode to one, and one such value fails the whole batch insert it rides in.
 * `max` clips by code point, never by UTF-16 unit, so the cut cannot split a
 * pair and make the surrogate itself (GHSA-89q9-r9vm-6vp2).
 */
export function cleanText(value: string | undefined | null, max?: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const cleaned = value.toWellFormed().replace(/\0/g, '').trim()
  if (max !== undefined && cleaned.length > max) {
    // Walks only the kept prefix: a header literal can be megabytes long.
    let end = 0
    let count = 0
    for (const point of cleaned) {
      if (count === max) return cleaned.slice(0, end).trimEnd() || undefined
      end += point.length
      count++
    }
  }
  return cleaned || undefined
}

export interface StoredMessageRef {
  folderPath: string
  uidvalidity: string
  uid: string
  textPart?: string
  htmlPart?: string
}

export interface FetchedBody {
  text: string
  /** Which part the text came from. `html` means it was converted. */
  source: 'text' | 'html' | 'none'
  /** The body was larger than a fetch may pull, and was cut. */
  cutAtSource: boolean
}

/** One message's readable text, fetched from the server. Never stored. */
export async function fetchMessageBody(instance: AppInstance, ref: StoredMessageRef): Promise<FetchedBody> {
  const part = ref.textPart ?? ref.htmlPart
  if (!part) return { text: '', source: 'none', cutAtSource: false }
  const source = ref.textPart ? 'text' : 'html'

  return await withFolder(instance, ref.folderPath, ref.uidvalidity, 'fetch the message body', async (client) => {
    const download = await client.download(ref.uid, part, { uid: true, maxBytes: BODY_MAX_BYTES })
    if (!download.content) {
      throw createError({ statusCode: 410, message: 'This message is no longer on the mail server.' })
    }
    const { buffer, cut } = await collect(download.content, BODY_MAX_BYTES)
    const raw = buffer.toString('utf8')
    // Synchronous on the shared event loop: html-text.ts keeps it linear.
    const text = source === 'html' ? htmlToText(raw) : raw
    return { text: text.replace(/\0/g, '').replace(/\r\n/g, '\n'), source, cutAtSource: cut }
  })
}

export interface FetchedAttachment {
  data: Buffer
  mimeType: string
  filename?: string
}

/**
 * One attachment's bytes, in memory, capped at `maxBytes`.
 *
 * `part` must already have been checked against the row's stored attachment
 * list by the caller — asking for an arbitrary part id would let a caller read
 * the body parts and nested messages through a route meant for files.
 */
export async function downloadAttachment(
  instance: AppInstance,
  ref: StoredMessageRef,
  attachment: MailAttachment,
  maxBytes: number,
): Promise<FetchedAttachment> {
  return await withFolder(instance, ref.folderPath, ref.uidvalidity, 'fetch the attachment', async (client) => {
    // One byte over the cap is enough to know it was over.
    const download = await client.download(ref.uid, attachment.part, { uid: true, maxBytes: maxBytes + 1 })
    if (!download.content) {
      throw createError({ statusCode: 410, message: 'This message is no longer on the mail server.' })
    }
    const { buffer, cut } = await collect(download.content, maxBytes)
    if (cut) {
      throw createError({
        statusCode: 413,
        message: `This attachment is larger than the ${formatBytes(maxBytes)} this connector fetches.`,
      })
    }
    return {
      data: buffer,
      mimeType: (download.meta?.contentType || attachment.mimeType).toLowerCase(),
      filename: attachment.filename ?? cleanText(download.meta?.filename),
    }
  })
}

async function collect(stream: NodeJS.ReadableStream, maxBytes: number): Promise<{ buffer: Buffer, cut: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    if (size + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - size))
      const destroy = (stream as unknown as { destroy?: () => void }).destroy
      if (typeof destroy === 'function') destroy.call(stream)
      return { buffer: Buffer.concat(chunks), cut: true }
    }
    chunks.push(buf)
    size += buf.length
  }
  return { buffer: Buffer.concat(chunks), cut: false }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

// ── drafts ─────────────────────────────────────────────────────────────────

export interface AppendedDraft {
  /** The folder path the server stored it under. */
  folder: string
  /** Present only when the server supports UIDPLUS. */
  uid?: string
}

/**
 * Store one finished message in `folderPath` flagged `\Draft`, unsent.
 *
 * A short-lived connection of its own rather than the cached `imapFor` one:
 * APPEND needs no selected mailbox, and keeping the write off the shared
 * client keeps every read on it provably read-only. `\Seen` too, so the draft
 * does not show up as unread mail in the owner's client.
 *
 * Not retried: a dropped connection after the server accepted the literal
 * would leave a draft behind, and a retry would leave two.
 */
export async function appendDraft(instance: AppInstance, folderPath: string, raw: Buffer): Promise<AppendedDraft> {
  const target = requireTarget(instance)
  let client: ImapFlow | undefined
  try {
    client = await openImap(target)
    const result = await client.append(folderPath, raw, ['\\Draft', '\\Seen'])
    if (!result) throw Object.assign(new Error('append returned no result'), { code: 'NoConnection' })
    return {
      folder: result.destination || folderPath,
      ...(result.uid !== undefined && { uid: String(result.uid) }),
    }
  }
  catch (cause) {
    if ((cause as ImapFlowError)?.mailboxMissing) {
      throw createError({ statusCode: 410, message: `The folder "${folderPath}" no longer exists on the mail server.` })
    }
    throw liveFailure(instance, cause, 'save the draft')
  }
  finally {
    if (client) await closeImap(client)
  }
}

// ── server-side body search ────────────────────────────────────────────────

export interface BodySearchFolder {
  path: string
  uidvalidity?: string
}

export interface BodySearchResult {
  /** Matching UIDs per folder, only for folders that answered. */
  matches: Array<{ path: string, uids: number[] }>
  searched: string[]
  /** Folders not searched: over the folder cap, out of time, or failed. */
  skipped: string[]
  /** The server's Gmail search syntax was used rather than IMAP `BODY`. */
  gmail: boolean
}

/**
 * Ask the mail server which messages' text contains `text`.
 *
 * Header search is SQL over synced rows; body text is not synced, so this is
 * the only way to search it. Matching is whatever the server implements —
 * substring on most, word-based on Gmail (`X-GM-RAW`) — and that is told to
 * the model rather than papered over. Bounded by folder count and wall clock,
 * and every folder not searched is named in `skipped`, since "no match" from a
 * search that did not run reads as "no such email".
 */
export async function searchMessageBodies(
  instance: AppInstance,
  folders: BodySearchFolder[],
  text: string,
): Promise<BodySearchResult> {
  let client = await imapFor(instance)
  if (!client.usable) {
    await closeImapFor(instance)
    client = await imapFor(instance)
  }
  const gmail = client.capabilities.has('X-GM-EXT-1')
  const deadline = Date.now() + SEARCH_BUDGET_MS
  const result: BodySearchResult = { matches: [], searched: [], skipped: [], gmail }

  for (const [index, folder] of folders.entries()) {
    if (index >= SEARCH_MAX_FOLDERS || Date.now() > deadline) {
      result.skipped.push(folder.path)
      continue
    }
    let lock
    try {
      lock = await client.getMailboxLock(folder.path, { readOnly: true, acquireTimeout: 10_000 })
      const mailbox = client.mailbox
      if (folder.uidvalidity !== undefined && mailbox && String(mailbox.uidValidity) !== folder.uidvalidity) {
        // Renumbered since the sync: its UIDs would join to the wrong rows.
        result.skipped.push(folder.path)
        continue
      }
      const uids = await client.search(gmail ? { gmraw: text } : { body: text }, { uid: true })
      result.searched.push(folder.path)
      if (uids && uids.length) result.matches.push({ path: folder.path, uids })
    }
    catch (cause) {
      console.error(`[imap] body search in a folder failed for connection ${instance.id} (${describeImapError(cause).code})`)
      result.skipped.push(folder.path)
    }
    finally {
      lock?.release()
    }
  }
  return result
}
