import QRCode from 'qrcode'
import { Api, Logger, TelegramClient, sessions } from 'teleproto'
import type { BridgeConfig } from './config.ts'
import { digestsEqual, hashKey, mintKey, seal, sessionContext, unseal, webhookContext } from './crypto.ts'
import type { Sql } from './db.ts'
import { HttpError, describeError, telegramNotConfigured } from './http-error.ts'
import { SessionLocks } from './locks.ts'
import { chatRow, entityId, inputPeerFor, markedId, usersOf } from './sync/convert.ts'
import { type ChatListing, SyncStore } from './sync/store.ts'
import { SessionSync, type SyncStatus } from './sync/syncer.ts'
import { deliverWebhook } from './webhook.ts'

/**
 * Every Telegram session this process runs.
 *
 * **State is read off the live client, never off a column.** The row says
 * whether a session *exists* (`session_enc`) and whether Telegram *revoked* it;
 * whether it is connected right now is only knowable from the client. That is
 * the lesson of the WhatsApp side, where a status column said "open" for a week
 * over a dead socket.
 *
 * A session moves through:
 *
 *   unlinked  no session_enc. `pair()` starts a QR flow.
 *   pairing   a QR flow is running (phase `qr`, then `password` if the account
 *             has two-step verification). Bounded by PAIRING_WINDOW_MS.
 *   linked    session_enc set; this process holds its lock, runs a client and
 *             syncs its chats (sync/syncer.ts).
 *   revoked   Telegram refused the session. session_enc is cleared; only a new
 *             pairing brings it back. Synced chats are kept for that pairing.
 *
 * Stopping the process disconnects clients and never logs them out: a redeploy
 * must not unlink anybody.
 */

export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown'

/** teleproto's LogLevel, reached through the exported Logger rather than a deep import. */
type LogLevel = NonNullable<ConstructorParameters<typeof Logger>[0]>

export interface SessionState {
  state: ConnectionState
  /** Linked, and the connection to Telegram is down. Reconnect, no scan. */
  sessionLost: boolean
  /** Telegram stopped accepting this session. Only pairing again fixes it. */
  revoked: boolean
  pairing?: 'qr' | 'password'
  /** Telegram's hint for the two-step verification password, if the account set one. */
  passwordHint?: string
  /** The last password submitted for this pairing was wrong. */
  passwordRejected?: boolean
  /** Another bridge process holds this session; this one cannot say how it is. */
  heldElsewhere: boolean
  me?: { id: string, username?: string, name?: string, phone?: string }
  lastError?: string
  stats: { chats: number, messages: number }
  sync: SyncStatus & {
    dialogsSyncedAt?: string
    /** Chats whose older history is still to be fetched. */
    pendingBackfill: number
  }
}

export interface PairingQr {
  /** `tg://login?token=…` — what the QR code encodes. As sensitive as the image. */
  url: string
  /** A PNG data URL of `url`. */
  dataUrl: string
  expiresAt: string
}

interface PairingFlow {
  abort: AbortController
  phase: 'qr' | 'password'
  qr?: PairingQr
  hint?: string
  passwordRejected: boolean
  /** Set while Telegram is waiting for the password; cleared once one is handed over. */
  submit?: (password: string) => void
}

interface Runtime {
  id: string
  client?: TelegramClient
  sync?: SessionSync
  /** The last probe of the client answered. */
  healthy: boolean
  revoked: boolean
  heldElsewhere: boolean
  pairing?: PairingFlow
  lastError?: string
  /** Signature of the last state sent to the webhook, to send each change once. */
  lastPublished?: string
}

interface SessionRow {
  id: string
  session_enc: string | null
  me_id: string | null
  me_username: string | null
  me_name: string | null
  me_phone: string | null
  revoked_at: Date | null
  webhook_url: string | null
  webhook_headers_enc: string | null
  update_pts: number | null
  update_qts: number | null
  update_date: number | null
  update_seq: number | null
  data_user_id: string | null
  dialogs_synced_at: Date | null
}

const SESSION_COLUMNS = [
  'id', 'session_enc', 'me_id', 'me_username', 'me_name', 'me_phone', 'revoked_at', 'webhook_url',
  'webhook_headers_enc', 'update_pts', 'update_qts', 'update_date', 'update_seq', 'data_user_id',
  'dialogs_synced_at',
]

/** How long a QR flow may wait for a scan (and a password) before it is abandoned. */
const PAIRING_WINDOW_MS = 5 * 60_000
const HEARTBEAT_MS = 30_000
const PROBE_TIMEOUT_MS = 20_000
const DISPOSE_TIMEOUT_MS = 10_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * RPC errors that mean the auth key is dead for good. Matched on the error code
 * rather than on teleproto's error classes, which a library bump can rename.
 *
 * AUTH_KEY_DUPLICATED belongs here: Telegram invalidates a key it saw used from
 * two connections at once, which is what the session locks exist to prevent.
 */
const REVOKED = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
])

/** Telegram's answers meaning "no such user or chat", as opposed to "you may not". */
const NOT_FOUND = new Set(['USERNAME_NOT_OCCUPIED', 'USERNAME_INVALID', 'PHONE_NOT_OCCUPIED'])

export class SessionManager {
  private readonly sql: Sql
  private readonly config: BridgeConfig
  private readonly locks: SessionLocks
  private readonly runtimes = new Map<string, Runtime>()
  private heartbeat: NodeJS.Timeout | undefined
  private ticking = false
  private stopping = false

  constructor(sql: Sql, config: BridgeConfig) {
    this.sql = sql
    this.config = config
    this.locks = new SessionLocks(config.databaseUrl, ids => this.onLocksLost(ids))
  }

  async start(): Promise<void> {
    this.locks.start()
    await this.tick()
    this.heartbeat = setInterval(() => { void this.tick() }, HEARTBEAT_MS)
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    clearInterval(this.heartbeat)
    for (const rt of this.runtimes.values()) {
      rt.pairing?.abort.abort()
      await this.dispose(rt)
    }
    await this.locks.close()
  }

  // ── requests ───────────────────────────────────────────────────────────────

  async create(name: string): Promise<{ id: string, name: string, apiKey: string }> {
    const apiKey = mintKey('tgs_')
    try {
      const [row] = await this.sql<{ id: string }[]>`
        INSERT INTO sessions (name, api_key_hash) VALUES (${name}, ${hashKey(apiKey)}) RETURNING id`
      return { id: row!.id, name, apiKey }
    }
    catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'A session with that name already exists.')
      }
      throw error
    }
  }

  /** Whether `presented` is this session's key. Unknown ids answer false, like wrong keys. */
  async authorize(id: string, presented: string | undefined): Promise<boolean> {
    if (!presented || !UUID.test(id)) return false
    const [row] = await this.sql<{ api_key_hash: string }[]>`SELECT api_key_hash FROM sessions WHERE id = ${id}`
    return row !== undefined && digestsEqual(row.api_key_hash, hashKey(presented))
  }

  async state(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const [counts] = await this.sql<{ chats: string, messages: string, pending: string }[]>`
      SELECT (SELECT count(*) FROM chats WHERE session_id = ${id}) AS chats,
             (SELECT count(*) FROM messages WHERE session_id = ${id} AND deleted_at IS NULL) AS messages,
             (SELECT count(*) FROM chats WHERE session_id = ${id} AND backfill_stopped IS NULL) AS pending`
    const rt = this.runtime(id)
    return describe(rt, row, this.config.telegram !== undefined, {
      chats: Number(counts?.chats ?? 0),
      messages: Number(counts?.messages ?? 0),
    }, Number(counts?.pending ?? 0))
  }

  /**
   * The QR code for a pairing in progress. Never starts one and never asks
   * Telegram for a token: a client polling this cannot turn into a stream of
   * login attempts, which is the failure the WhatsApp QR poll has to be kept
   * away from by hand.
   */
  async qr(id: string): Promise<{ state: SessionState, qr?: PairingQr }> {
    const state = await this.state(id)
    return { state, qr: this.runtimes.get(id)?.pairing?.qr }
  }

  /** Start a QR flow. Idempotent while one is already running. */
  async pair(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const rt = this.runtime(id)
    if (rt.pairing) return await this.state(id)
    if (row.session_enc) {
      throw new HttpError(409, 'This session is already linked to a Telegram account. Log it out before pairing again.')
    }

    if (!(await this.locks.acquire(id))) {
      rt.heldElsewhere = true
      throw new HttpError(409, 'Another bridge process holds this session. Only one process may run a session at a time.')
    }
    rt.heldElsewhere = false
    // Re-checked after the await: two requests can both get past the first check.
    if (rt.pairing) return await this.state(id)

    const flow: PairingFlow = { abort: new AbortController(), phase: 'qr', passwordRejected: false }
    rt.pairing = flow
    rt.revoked = false
    rt.lastError = undefined

    const timer = setTimeout(() => flow.abort.abort(), PAIRING_WINDOW_MS)
    timer.unref()
    void this.runPairing(rt, flow).finally(() => clearTimeout(timer))

    this.publish(rt)
    return await this.state(id)
  }

  /**
   * Hand the two-step verification password to the pairing waiting for it.
   *
   * It passes straight through to Telegram's SRP check: never stored, never
   * logged, and not kept on the flow after it is handed over.
   */
  async submitPassword(id: string, password: string): Promise<SessionState> {
    await this.row(id)
    const flow = this.runtimes.get(id)?.pairing
    const submit = flow?.phase === 'password' ? flow.submit : undefined
    if (!flow || !submit) {
      throw new HttpError(409, 'This session is not waiting for a two-step verification password.')
    }
    flow.submit = undefined
    flow.passwordRejected = false
    submit(password)
    return await this.state(id)
  }

  /**
   * Unlink: log out on Telegram's side where possible, then forget the session
   * **and everything synced for it** — logging out is the owner saying this
   * account should no longer be reachable from here.
   *
   * Forgetting happens even if Telegram could not be reached. The alternative is
   * a session nobody can remove; what is left over is an entry in the account's
   * Telegram → Devices list, which the owner can terminate there.
   */
  async logout(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const rt = this.runtime(id)
    rt.pairing?.abort.abort()

    if (row.session_enc) {
      if (!(await this.locks.acquire(id))) {
        rt.heldElsewhere = true
        throw new HttpError(409, 'Another bridge process holds this session. Log it out there.')
      }
      rt.heldElsewhere = false

      let saved: string | undefined
      if (!this.config.telegram) {
        // No credentials to reach Telegram with. What is left is an entry in the
        // account's Telegram → Devices, the same as any failed remote logout.
        console.error(`[sessions] ${id}: TELEGRAM_API_ID / TELEGRAM_API_HASH are not set, so it cannot be logged out on Telegram's side; forgetting it anyway`)
      }
      else {
        try {
          saved = rt.client ? undefined : this.openSession(id, row.session_enc)
        }
        catch {
          console.error(`[sessions] ${id}: the stored session could not be decrypted, so it cannot be logged out on Telegram's side; forgetting it anyway`)
        }
      }

      if (rt.client || saved !== undefined) {
        try {
          if (!rt.client) {
            rt.client = this.newClient(new sessions.StringSession(saved))
            await withTimeout(rt.client.connect(), PROBE_TIMEOUT_MS)
          }
          rt.sync?.stop()
          await withTimeout(rt.client.logOut(), PROBE_TIMEOUT_MS)
        }
        catch (error) {
          if (!isRevocation(error)) {
            console.error(`[sessions] ${id}: Telegram-side logout failed (${describeError(error)}); forgetting the session anyway`)
          }
        }
      }
    }

    await this.dispose(rt, { saveState: false })
    await new SyncStore(this.sql, id).wipe()
    await this.sql`
      UPDATE sessions
      SET session_enc = NULL, authorized_at = NULL, revoked_at = NULL,
          me_id = NULL, me_username = NULL, me_name = NULL, me_phone = NULL, updated_at = now()
      WHERE id = ${id}`
    rt.revoked = false
    rt.lastError = undefined
    await this.locks.release(id)
    this.publish(rt)
    return await this.state(id)
  }

  /**
   * Drop the client and connect again from the stored session. Answers at once;
   * the connection is made in the background and shows up in `state`.
   */
  async reconnect(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const rt = this.runtime(id)
    if (!row.session_enc) {
      throw new HttpError(409, row.revoked_at
        ? 'Telegram no longer accepts this session. It has to be paired again.'
        : 'This session is not linked to a Telegram account.')
    }
    if (!(await this.locks.acquire(id))) {
      rt.heldElsewhere = true
      throw new HttpError(409, 'Another bridge process holds this session.')
    }
    rt.heldElsewhere = false

    await this.dispose(rt)
    // Reached by a request: a rejection here (lock or DB read failing) must be
    // logged, never left unhandled. The heartbeat retries.
    this.resume(rt, await this.row(id))
      .catch(error => console.error(`[sessions] ${id}: reconnect failed: ${describeError(error)}`))
      .finally(() => this.publish(rt))
    return await this.state(id)
  }

  /** Log out, then delete the row and everything synced for it. */
  async remove(id: string): Promise<void> {
    await this.row(id)
    try {
      await this.logout(id)
    }
    catch (error) {
      if (!(error instanceof HttpError)) throw error
      // Held by another process: it drops the client on its next heartbeat,
      // when it finds the row gone.
      console.error(`[sessions] ${id}: deleting without a Telegram-side logout: ${error.message}`)
    }
    await this.sql`DELETE FROM sessions WHERE id = ${id}`
    this.runtimes.delete(id)
  }

  async setWebhook(id: string, url: string | null, headers: Record<string, string>): Promise<void> {
    const previous = await this.row(id)
    const sealed = url && Object.keys(headers).length > 0
      ? seal(this.config.sealKey, JSON.stringify(headers), webhookContext(id))
      : null
    await this.sql`
      UPDATE sessions SET webhook_url = ${url}, webhook_headers_enc = ${sealed}, updated_at = now()
      WHERE id = ${id}`
    // A new destination gets the current state even if it has not changed. The
    // same destination does not: the app re-registers every hour, and a delivery
    // per re-registration would run a second health check beside its own sweep.
    if (previous.webhook_url === url) return
    const rt = this.runtime(id)
    rt.lastPublished = undefined
    this.publish(rt)
  }

  /** Synced chats, most recently active first. Served from the database; works while disconnected. */
  async chats(id: string, take: number, skip: number): Promise<{ chats: ChatListing[], hasMore: boolean }> {
    await this.row(id)
    return await new SyncStore(this.sql, id).listChats(take, skip)
  }

  /**
   * Find a chat by @username, t.me link or phone number.
   *
   * Resolving is not joining: a user found here is remembered (so a message can
   * be sent to them), but a chat row appears only once there are messages. A
   * phone number resolves only where that person's privacy settings allow it.
   */
  async resolve(id: string, query: string): Promise<{
    chatId: string
    type: string
    title: string | null
    username: string | null
    known: boolean
  }> {
    await this.row(id)
    const client = this.connectedClient(this.runtime(id))
    const target = parseResolveQuery(query)
    if (!target) throw new HttpError(400, 'Expected an @username, a t.me link, or a phone number.')

    let result: Api.contacts.ResolvedPeer
    try {
      result = await client.invoke('username' in target
        ? new Api.contacts.ResolveUsername({ username: target.username })
        : new Api.contacts.ResolvePhone({ phone: target.phone }))
    }
    catch (error) {
      throw toHttpError(error)
    }

    const store = new SyncStore(this.sql, id)
    const entities = [...result.users, ...result.chats]
    await store.upsertUsers(usersOf(entities))

    const chatId = markedId(result.peer)
    const row = chatRow(entities.find(entity => entityId(entity) === chatId))
    if (row) await store.refreshKnownChats([row])
    const known = await store.chat(chatId)

    return {
      chatId,
      type: row?.type ?? known?.type ?? 'private',
      title: row?.title ?? known?.title ?? null,
      username: row?.username ?? known?.username ?? null,
      known: known !== undefined,
    }
  }

  /**
   * Send plain text. Formatting is **never** parsed: text written by a model goes
   * out exactly as written, not reinterpreted as Markdown.
   */
  async send(id: string, chatId: string, text: string): Promise<{ chatId: string, messageId: number, date: string }> {
    await this.row(id)
    const rt = this.runtime(id)
    const client = this.connectedClient(rt)
    const store = new SyncStore(this.sql, id)

    const chat = await store.chat(chatId)
    if (chat?.migrated_to) {
      throw new HttpError(409, `This group was upgraded to a supergroup. Send to ${chat.migrated_to} instead.`)
    }
    const accessHash = chat?.access_hash ?? (BigInt(chatId) > 0n ? await store.userAccessHash(chatId) : null)
    const peer = chat || accessHash ? inputPeerFor(chatId, accessHash) : undefined
    if (!peer) {
      throw new HttpError(404, 'This chat is not known to the bridge. List chats, or resolve the user first.')
    }

    let message: Api.Message
    try {
      message = await client.sendMessage(peer, { message: text, parseMode: false })
    }
    catch (error) {
      throw toHttpError(error)
    }
    await rt.sync?.saveMessages([message])
    return { chatId, messageId: message.id, date: new Date(message.date * 1000).toISOString() }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private async runPairing(rt: Runtime, flow: PairingFlow): Promise<void> {
    const session = new sessions.StringSession('')
    const client = this.newClient(session)
    const { signal } = flow.abort

    try {
      await client.connect()
      const user = await client.signInUserWithQrCode(
        this.credentials(),
        {
          abortSignal: signal,
          qrCode: async ({ token, expires }) => {
            const url = `tg://login?token=${token.toString('base64url')}`
            flow.qr = {
              url,
              dataUrl: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 320 }),
              expiresAt: new Date(expires * 1000).toISOString(),
            }
            flow.phase = 'qr'
          },
          password: hint => new Promise<string>((resolve, reject) => {
            if (signal.aborted) return reject(abortError())
            flow.phase = 'password'
            flow.qr = undefined
            flow.hint = hint || undefined
            flow.submit = resolve
            signal.addEventListener('abort', () => reject(abortError()), { once: true })
            this.publish(rt)
          }),
          // Called for failures inside the password step. A wrong password is
          // retried (teleproto asks for it again); anything else ends the flow.
          onError: async (error) => {
            if (describeError(error) === 'PASSWORD_HASH_INVALID') {
              flow.passwordRejected = true
              return false
            }
            return true
          },
        },
      )
      if (signal.aborted) throw abortError()

      await this.sql`
        UPDATE sessions
        SET session_enc = ${seal(this.config.sealKey, session.save(), sessionContext(rt.id))},
            authorized_at = now(), revoked_at = NULL, updated_at = now()
        WHERE id = ${rt.id}`
      const meId = await this.recordMe(rt.id, user)
      await this.claimData(rt.id, meId)

      const sync = new SessionSync(client, this.sql, rt.id, meId, this.config.backfill)
      sync.attach()
      rt.client = client
      rt.sync = sync
      rt.healthy = true
      rt.revoked = false
      rt.lastError = undefined
      console.info(`[sessions] ${rt.id}: linked`)
      void sync.start()
    }
    catch (error) {
      await destroyClient(client)
      rt.lastError = signal.aborted
        ? 'Pairing was not completed in time, or was cancelled. Start it again to get a new QR code.'
        : describeError(error)
      if (!signal.aborted) console.error(`[sessions] ${rt.id}: pairing failed: ${rt.lastError}`)
      await this.locks.release(rt.id)
    }
    finally {
      rt.pairing = undefined
      this.publish(rt)
    }
  }

  /** Connect a linked session from its stored string, and resume syncing it. */
  private async resume(rt: Runtime, row: SessionRow): Promise<void> {
    if (rt.client || rt.pairing || !row.session_enc || this.stopping) return
    // Linked earlier, and the credentials have since been removed. Nothing to
    // connect with; `describe` reports it as closed, with the reason.
    if (!this.config.telegram) return
    if (!(await this.locks.acquire(rt.id))) {
      rt.heldElsewhere = true
      return
    }
    rt.heldElsewhere = false

    let saved: string
    try {
      saved = this.openSession(rt.id, row.session_enc)
    }
    catch {
      rt.lastError = 'The stored session could not be decrypted. Has TELEGRAM_SESSION_ENCRYPTION_KEY changed?'
      console.error(`[sessions] ${rt.id}: ${rt.lastError}`)
      return
    }

    const client = this.newClient(new sessions.StringSession(saved))
    // Seeded before connect: teleproto fetches a fresh state on connect only when
    // it has none, and a fresh state would skip everything missed while down.
    if (row.update_pts !== null && row.update_qts !== null && row.update_date !== null && row.update_seq !== null) {
      client.updateManager.refreshFromState({
        pts: row.update_pts,
        qts: row.update_qts,
        date: row.update_date,
        seq: row.update_seq,
      })
    }
    // Attached before connect, so the catch-up difference has somewhere to go.
    const sync = new SessionSync(client, this.sql, rt.id, row.me_id, this.config.backfill)
    sync.attach()
    rt.client = client
    rt.sync = sync

    try {
      await withTimeout(client.connect(), PROBE_TIMEOUT_MS)
      const me = await withTimeout(client.getMe(), PROBE_TIMEOUT_MS)
      rt.healthy = true
      rt.lastError = undefined
      await this.recordMe(rt.id, me)
      void sync.start()
    }
    catch (error) {
      if (isRevocation(error)) {
        await this.markRevoked(rt, error)
        return
      }
      // Transient. Drop the client but keep the lock: the next heartbeat tries
      // again, and this process is still the one entitled to.
      rt.lastError = describeError(error)
      console.error(`[sessions] ${rt.id}: could not connect: ${rt.lastError}`)
      await this.dispose(rt, { saveState: false })
    }
  }

  private async probe(rt: Runtime): Promise<void> {
    const client = rt.client
    if (!client || rt.pairing) return
    try {
      await withTimeout(client.invoke(new Api.updates.GetState()), PROBE_TIMEOUT_MS)
      rt.healthy = true
      rt.lastError = undefined
      await this.saveUpdateState(rt)
    }
    catch (error) {
      if (isRevocation(error)) return await this.markRevoked(rt, error)
      rt.healthy = false
      rt.lastError = describeError(error)
    }
  }

  private async markRevoked(rt: Runtime, error: unknown): Promise<void> {
    const reason = describeError(error)
    console.error(`[sessions] ${rt.id}: Telegram no longer accepts this session (${reason}); it must be paired again`)
    await this.dispose(rt, { saveState: false })
    await this.sql`UPDATE sessions SET session_enc = NULL, revoked_at = now(), updated_at = now() WHERE id = ${rt.id}`
    rt.revoked = true
    rt.lastError = reason
    await this.locks.release(rt.id)
    this.publish(rt)
  }

  /**
   * The heartbeat: converge what this process runs on what the table says.
   * Connects linked sessions it does not run yet (including ones another process
   * released), probes the ones it does, and drops clients whose row went away.
   */
  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return
    this.ticking = true
    try {
      const rows = await this.sql<SessionRow[]>`SELECT ${this.sql(SESSION_COLUMNS)} FROM sessions`
      const byId = new Map(rows.map(row => [row.id, row]))

      for (const rt of [...this.runtimes.values()]) {
        const row = byId.get(rt.id)
        if (row?.session_enc || rt.pairing) continue
        // Deleted, or logged out by another process.
        if (rt.client) await this.dispose(rt, { saveState: false })
        await this.locks.release(rt.id)
        if (!row) this.runtimes.delete(rt.id)
      }

      for (const row of rows) {
        const rt = this.runtime(row.id)
        if (row.revoked_at) rt.revoked = true
        if (rt.client) await this.probe(rt)
        else await this.resume(rt, row)
        this.publish(rt)
      }
    }
    catch (error) {
      console.error(`[sessions] heartbeat failed: ${describeError(error)}`)
    }
    finally {
      this.ticking = false
    }
  }

  private onLocksLost(ids: string[]): void {
    for (const id of ids) {
      const rt = this.runtimes.get(id)
      if (!rt) continue
      console.error(`[sessions] ${id}: lost its session lock; disconnecting until it is taken again`)
      rt.pairing?.abort.abort()
      void this.dispose(rt).then(() => this.publish(rt))
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id)
    if (!rt) {
      rt = { id, healthy: false, revoked: false, heldElsewhere: false }
      this.runtimes.set(id, rt)
    }
    return rt
  }

  private async row(id: string): Promise<SessionRow> {
    const row = UUID.test(id)
      ? (await this.sql<SessionRow[]>`SELECT ${this.sql(SESSION_COLUMNS)} FROM sessions WHERE id = ${id}`)[0]
      : undefined
    if (!row) throw new HttpError(404, 'No such session.')
    return row
  }

  private connectedClient(rt: Runtime): TelegramClient {
    if (!rt.client?.connected || !rt.healthy) {
      throw new HttpError(409, 'This session is not connected to Telegram right now.')
    }
    return rt.client
  }

  private openSession(id: string, sealed: string): string {
    return unseal(this.config.sealKey, sealed, sessionContext(id))
  }

  /**
   * Telegram's app credentials, or the not-configured refusal. The HTTP layer
   * already refuses the routes that would get here; this is what stops any other
   * path building a client without them.
   */
  private credentials(): { apiId: number, apiHash: string } {
    if (!this.config.telegram) throw telegramNotConfigured()
    return this.config.telegram
  }

  private newClient(session: sessions.StringSession): TelegramClient {
    const logger = new Logger('warn' as LogLevel)
    logger.handler = (record) => {
      const level = String(record.level)
      if (level !== 'error' && level !== 'warn') return
      console.error(`[teleproto] ${level}: ${String(record.message).slice(0, 300)}`)
    }
    const { apiId, apiHash } = this.credentials()
    return new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: 60,
      testServers: this.config.testServers,
      baseLogger: logger,
      deviceModel: 'Automata MCP',
      systemVersion: 'bridge',
      appVersion: '1.0',
    })
  }

  /**
   * Stop syncing and drop the client. The update state is saved first by default,
   * so the next connect catches up from here rather than from the last heartbeat.
   */
  private async dispose(rt: Runtime, options: { saveState?: boolean } = {}): Promise<void> {
    const client = rt.client
    const sync = rt.sync
    if (options.saveState !== false) await this.saveUpdateState(rt)
    rt.client = undefined
    rt.sync = undefined
    rt.healthy = false
    sync?.stop()
    if (client) await destroyClient(client)
  }

  private async saveUpdateState(rt: Runtime): Promise<void> {
    const state = rt.sync?.updateState()
    if (!state) return
    await new SyncStore(this.sql, rt.id).saveUpdateState(state)
      .catch(error => console.error(`[sessions] ${rt.id}: could not save update state: ${describeError(error)}`))
  }

  private async recordMe(id: string, user: unknown): Promise<string | null> {
    if (!(user instanceof Api.User)) return null
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || null
    const meId = user.id.toString()
    await this.sql`
      UPDATE sessions
      SET me_id = ${meId}, me_username = ${user.username ?? null},
          me_name = ${name}, me_phone = ${user.phone ?? null}, updated_at = now()
      WHERE id = ${id}`
    return meId
  }

  /**
   * Chats synced for one Telegram account are that account's. Linking a
   * different one discards them instead of mixing two people's chats under one
   * connection. The same account scanning again (after a revocation) keeps them.
   */
  private async claimData(id: string, meId: string | null): Promise<void> {
    const [row] = await this.sql<{ data_user_id: string | null }[]>`SELECT data_user_id FROM sessions WHERE id = ${id}`
    if (row?.data_user_id && row.data_user_id !== meId) {
      console.info(`[sessions] ${id}: a different Telegram account was linked; discarding the chats synced for the previous one`)
      await new SyncStore(this.sql, id).wipe()
    }
    await this.sql`
      UPDATE sessions SET data_user_id = ${meId},
        update_pts = NULL, update_qts = NULL, update_date = NULL, update_seq = NULL
      WHERE id = ${id}`
  }

  /** Send a state change to the session's webhook, once per change. Never throws. */
  private publish(rt: Runtime): void {
    void (async () => {
      try {
        const [row] = await this.sql<SessionRow[]>`SELECT ${this.sql(SESSION_COLUMNS)} FROM sessions WHERE id = ${rt.id}`
        if (!row?.webhook_url) return

        const state = describe(rt, row, this.config.telegram !== undefined, { chats: 0, messages: 0 }, 0)
        const signature = [state.state, state.sessionLost, state.revoked, state.pairing ?? ''].join('|')
        if (signature === rt.lastPublished) return
        rt.lastPublished = signature

        const headers = row.webhook_headers_enc
          ? JSON.parse(unseal(this.config.sealKey, row.webhook_headers_enc, webhookContext(rt.id))) as Record<string, string>
          : {}
        await deliverWebhook(row.webhook_url, headers, {
          event: 'connection.update',
          sessionId: rt.id,
          state: state.state,
          sessionLost: state.sessionLost,
          revoked: state.revoked,
        })
      }
      catch (error) {
        console.error(`[webhook] ${rt.id}: ${describeError(error)}`)
      }
    })()
  }
}

function describe(rt: Runtime, row: SessionRow, telegramConfigured: boolean, stats: SessionState['stats'], pendingBackfill: number): SessionState {
  const base = {
    sessionLost: false,
    revoked: rt.revoked || row.revoked_at !== null,
    heldElsewhere: rt.heldElsewhere,
    lastError: rt.lastError,
    stats,
    sync: {
      ...(rt.sync?.status() ?? { backfilling: false }),
      dialogsSyncedAt: row.dialogs_synced_at?.toISOString(),
      pendingBackfill,
    },
    me: row.me_id
      ? {
          id: row.me_id,
          username: row.me_username ?? undefined,
          name: row.me_name ?? undefined,
          phone: row.me_phone ?? undefined,
        }
      : undefined,
  }

  if (rt.pairing) {
    return {
      ...base,
      state: 'connecting',
      pairing: rt.pairing.phase,
      passwordHint: rt.pairing.phase === 'password' ? rt.pairing.hint : undefined,
      passwordRejected: rt.pairing.passwordRejected || undefined,
    }
  }
  if (!row.session_enc) return { ...base, state: 'close' }
  // Linked, and the bridge has since lost its credentials: closed, not a dropped
  // connection that a Reconnect could fix.
  if (!telegramConfigured) return { ...base, state: 'close', lastError: telegramNotConfigured().message }
  if (rt.heldElsewhere) return { ...base, state: 'unknown' }
  if (rt.client?.connected && rt.healthy) return { ...base, state: 'open' }
  return { ...base, state: 'connecting', sessionLost: true }
}

/** `@name`, `name`, `t.me/name` (with or without https://), or a phone number. */
function parseResolveQuery(query: string): { username: string } | { phone: string } | undefined {
  const value = query.trim()
  const link = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(value)
  if (link?.[1]) return { username: link[1] }
  const username = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(value)
  if (username?.[1]) return { username: username[1] }
  const phone = /^\+?(\d[\d\s-]{5,20}\d)$/.exec(value)
  if (phone?.[1]) return { phone: phone[1].replace(/\D/g, '') }
  return undefined
}

/**
 * A Telegram RPC failure as an HTTP answer the caller can act on: 429 for a flood
 * wait, 404 for "no such user", 422 for any other refusal, carrying Telegram's
 * code. Anything that is not an RPC error is rethrown and becomes a 500.
 */
function toHttpError(error: unknown): HttpError {
  const code = describeError(error)
  if (/^FLOOD_(PREMIUM_)?WAIT/.test(code)) {
    return new HttpError(429, `Telegram asked to slow down (${code}). Try again later.`)
  }
  if (NOT_FOUND.has(code)) return new HttpError(404, `Telegram found nothing for that (${code}).`)
  if (/^[A-Z][A-Z0-9_]+$/.test(code)) return new HttpError(422, `Telegram refused the request: ${code}.`)
  throw error
}

function isRevocation(error: unknown): boolean {
  return REVOKED.has(describeError(error))
}

function abortError(): Error {
  const error = new Error('pairing aborted')
  error.name = 'AbortError'
  return error
}

async function destroyClient(client: TelegramClient): Promise<void> {
  await withTimeout(client.destroy(), DISPOSE_TIMEOUT_MS).catch(() => {})
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}
