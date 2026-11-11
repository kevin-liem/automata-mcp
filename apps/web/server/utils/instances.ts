import { assertNever } from '#shared/connection'
import { randomBytes } from 'node:crypto'
import { rememberBounded } from './lookup-cache'
import type { AppInstance } from './app-db'
import type { EvolutionInstanceRecord } from './evolution-db'
import type { ImapSecurity, ImapTarget } from './imap-client'
import type { HostedEvent } from './hosted-events'
import type { Actor } from './org'
import type { ConnectionState } from '#shared/connection'

/**
 * Evolution instance lifecycle. Every call that touches Evolution's instance
 * endpoints lives here, so the admin-key blast radius is one file.
 */

// Declared in `shared/connection.ts`; see there for why it is not local.
export type { ConnectionState }

// A type alias rather than an interface on purpose: MCP tool handlers may return
// `Record<string, unknown>`, and interfaces have no implicit index signature, so
// an interface here fails to typecheck at the tool that returns it.
export type InstanceStatus = {
  /** Evolution's live, in-memory state — not its stored column. See `getInstanceStatus`. */
  state: ConnectionState
  /**
   * The account was connected and its socket no longer is, with the phone still
   * linked. Distinct from never having paired, and answered by reconnecting
   * rather than by scanning a QR code.
   */
  sessionLost?: boolean
  /**
   * Evolution has been reopening this account's socket over and over for at
   * least `CHURN_CONFIRM_MS`, while its column reads `open`. Reconnect cannot
   * end it; restarting the Evolution service does. See `rowChurn`.
   */
  flapping?: boolean
  /**
   * The account reads `open` — live and stored — but a send or a group lookup
   * since Evolution last opened its socket failed with `Connection Closed`:
   * Evolution's own session for the account is stuck. Reconnect cannot end it
   * (it answers 409 from `open`); restarting the Evolution service does. See
   * `socketStalled` and socket-evidence.ts (#205).
   */
  stalled?: boolean
  /**
   * Set only with `flapping` or `stalled`: the deployment's operator is alerted
   * by itself and will restart Evolution, so the reader has nothing to do.
   * Hosted offering only — `operatorAlertedAboutLoop` in alerts.ts is the rule,
   * shared with the outage mail so the two cannot disagree.
   */
  operatorAlerted?: boolean
  profileName?: string
  profilePicUrl?: string
  number?: string
  ownerJid?: string
  disconnectedAt?: string
  /**
   * Absent when the counts could not be measured in time (a count that hit the
   * statement timeout with nothing cached, or Evolution unreachable). Absent is
   * never zero: the dashboard shows it as unavailable. See `cachedSqlCounts`.
   */
  stats?: {
    messages: number
    chats: number
    contacts: number
  }
}

export interface InstanceQr {
  base64?: string
  code?: string
  pairingCode?: string
  count?: number
}

/** What the UI is allowed to see. Never includes a secret field. */
export interface PublicInstance {
  id: string
  kind: InstanceKind
  name: string
  label: string
  created?: string
  /**
   * Where this connection points, for display. The Evolution base URL is not a
   * secret; the Postgres DSN is, so only its host, port and database name are
   * surfaced and never the credentials in it.
   */
  target?: string
  /** True when this WhatsApp connection uses a server the user supplied. */
  ownServer?: boolean
  /**
   * Whether `read-messages` and `search-messages` can answer for this
   * connection at all.
   *
   * Computed here rather than in the client: it depends on the precedence
   * between a connection's own database URL and the deployment's variable, and
   * a second implementation of that rule in the UI would drift.
   */
  canReadMessages?: boolean
  /**
   * WhatsApp only, and only while it has never been paired: when
   * `reapUnpairedConnections` will delete it. Absent once paired, for good.
   */
  unpairedRemovalAt?: string
}

export function toPublicInstance(instance: AppInstance): PublicInstance {
  const kind = instanceKind(instance)
  const base = { id: instance.id, kind, name: instance.name, created: instance.created }

  switch (kind) {
    case 'postgres':
      return {
        ...base,
        label: instance.label || 'Database',
        target: [instance.db_host, instance.db_port].filter(Boolean).join(':')
          + (instance.db_database ? `/${instance.db_database}` : ''),
      }
    case 'whatsapp':
      return {
        ...base,
        label: instance.label || 'WhatsApp account',
        target: instance.base_url,
        ownServer: Boolean(instance.admin_key),
        // Not recomputed here: `canReadMessages` in evolution-db.ts is the rule,
        // and the comment there calls itself the only place it lives.
        canReadMessages: canReadMessages(instance),
        unpairedRemovalAt: unpairedRemovalAt(instance),
      }
    case 'telegram':
      return {
        ...base,
        label: instance.label || 'Telegram account',
        target: instance.base_url,
        // A bridge the user runs carries its own admin key.
        ownServer: Boolean(instance.admin_key),
        // Telegram's own rule, not Evolution's: see `telegramDbUrlFor`.
        canReadMessages: canReadTelegramMessages(instance),
      }
    case 'imap':
      return {
        ...base,
        label: instance.label || 'Mailbox',
        // The login and the server, never the password.
        target: instance.imap_user && instance.imap_host
          ? `${instance.imap_user} @ ${instance.imap_host}:${instance.imap_port ?? ''}`
          : undefined,
      }
    default:
      return assertNever(kind, 'connection kind')
  }
}

/**
 * Instance names are server-generated and land in Evolution's URLs. Random
 * rather than derived from the user id, so one user can hold several and no
 * name leaks who owns it.
 */
export function generateInstanceName(): string {
  return `i-${randomBytes(8).toString('base64url')}`
}

/**
 * The connections one actor may see.
 *
 * An admin sees their whole organization's; a member sees only what is assigned
 * to them. Both are a **predicate in the query**, never a filter applied to rows
 * after they are read — the same rule chat scope and the Postgres table
 * allowlist follow, and it is what keeps this from becoming an enumeration
 * surface: a member must not learn the size or the labels of the estate.
 */
export async function listInstancesForActor(actor: Actor): Promise<AppInstance[]> {
  const sql = await appDb()

  if (actor.role === 'admin') {
    return await sql<AppInstance[]>`
      SELECT * FROM app.instances WHERE org = ${actor.org.id} ORDER BY created
    `
  }

  // The organization predicate is kept even though every assignment already
  // implies it: an assignment left behind by a member who has since moved
  // organizations must not reach back into their old one.
  return await sql<AppInstance[]>`
    SELECT i.* FROM app.instances i
    JOIN app.instance_assignments a ON a.instance = i.id AND a.user_id = ${actor.user.id}
    WHERE i.org = ${actor.org.id}
    ORDER BY i.created
  `
}

/**
 * Create an Evolution instance and record it.
 *
 * Two systems, so there is a window where they can disagree. Evolution is
 * written first; if the database write then fails we issue a compensating
 * delete so no orphan instance is left holding a socket on the Evolution
 * server. That compensating call is best-effort by necessity — if it also
 * fails, the original error is still what the caller needs to see.
 *
 * This is also the single place an instances-per-user cap would go.
 */
export interface WhatsappProvisionInput {
  label?: string
  /**
   * A bring-your-own Evolution server. `baseUrl` and `adminKey` are both halves
   * of one thing and must arrive together; `dbUrl` is independently optional —
   * without it the account pairs and sends but cannot be read, because reads go
   * to Evolution's database and this app would not know which one.
   */
  server?: { baseUrl: string, adminKey: string, dbUrl?: string }
  /**
   * Ask WhatsApp for the account's full history at pairing, rather than the
   * recent slice it hands any linked device. The owner's choice on the create
   * form, off by default — a full import is most of the disk an account costs.
   * Refused (402) on our server for an organization limited to recent history.
   */
  fullHistory?: boolean
}

export async function provisionWhatsappInstance(
  actor: Actor,
  input: WhatsappProvisionInput = {},
): Promise<AppInstance> {
  const { label, server } = input
  const fullHistory = input.fullHistory === true

  // First, before any setup check or remote call: a plan refusal is the answer
  // whatever else is wrong. A user's own server is their disk, so the plan's
  // history limit never applies there.
  if (fullHistory && !server && await orgRecentHistoryOnly(await appDb(), actor.org.id)) {
    throw fullHistoryLimitError()
  }

  // Refused on the hosted service before the address is even resolved; then
  // guarded before the first request rather than only inside the client, so a
  // bad URL fails the create with a message about the URL instead of surfacing
  // as a failed Evolution call.
  if (server) {
    assertOwnServersAllowed('Evolution server', actor.org.id)
    await assertPublicUrl(server.baseUrl, 'Evolution server URL')
  }

  // Proved before anything is provisioned, so a bad database URL costs nothing
  // — no Evolution instance to tear down, no row to clean up. `requireTable`
  // catches the case that matters: a URL that connects to the wrong database.
  if (server?.dbUrl) await probePgConnection(server.dbUrl, { requireTable: '"Message"' })

  const creds = evolutionAdminCredentials(
    server ? { base_url: server.baseUrl, admin_key: server.adminKey } : undefined,
  )
  if (!creds) {
    throw createError({
      statusCode: 422,
      statusMessage: 'No Evolution server is available. Set NUXT_EVOLUTION_URL and '
        + 'NUXT_EVOLUTION_ADMIN_KEY to provide a default'
        + (ownServersAllowed() ? ', or supply your own server URL and admin key.' : '.'),
    })
  }

  const admin = createEvolutionClient(creds)
  const name = generateInstanceName()

  const created = await admin<{ instance?: { instanceId?: string }, hash?: string | { apikey?: string } }>(
    '/instance/create',
    {
      method: 'POST',
      body: {
        instanceName: name,
        integration: 'WHATSAPP-BAILEYS',
        // Creating without a QR returns immediately; Evolution otherwise blocks
        // ~5s waiting for one. The pairing page asks for the QR separately.
        qrcode: false,
        // WhatsApp hands over history exactly once, during the initial login, so
        // this has to be true *before* the QR is scanned — there is no endpoint
        // that fetches history later. Side effect worth knowing: Evolution's
        // `shouldIgnoreJid` stops filtering `@g.us` when this is on, so group
        // chats sync too, regardless of `groupsIgnore`.
        //
        // Off unless the owner ticked "Import full history" when creating it:
        // Baileys then sends `requireFullSync: false`, and WhatsApp hands over
        // only the recent slice it gives any linked browser — still imported,
        // since Evolution persists every history sync type under
        // SAVE_DATA.HISTORIC.
        syncFullHistory: fullHistory,
      },
    },
  )

  // Older Evolution releases returned `hash` as `{ apikey }`. We pin v2.3.7,
  // where it is a plain string, but accept both so an upgrade fails loudly at
  // the check below rather than silently storing "[object Object]".
  const apiKey = typeof created?.hash === 'string' ? created.hash : created?.hash?.apikey

  if (!apiKey) {
    await admin(`/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    throw createError({
      statusCode: 502,
      statusMessage: 'Evolution API did not return an instance token',
    })
  }

  let record: AppInstance

  try {
    record = await insertRow<AppInstance>('instances', {
      // The organization owns it; `created_by` is provenance and grants nothing.
      org: actor.org.id,
      created_by: actor.user.id,
      kind: 'whatsapp',
      name,
      instance_id: created?.instance?.instanceId ?? '',
      api_key: apiKey,
      // The URL actually used, never runtimeConfig — otherwise a BYO instance
      // would be recorded as living on our server and every later call would go
      // to the wrong one.
      base_url: creds.baseUrl,
      // Stored only for a server the user supplied. A connection on the
      // deployment default keeps following that default, including if it moves.
      admin_key: server ? server.adminKey : '',
      // Same: only ever set for a user's own server. A default-server connection
      // reads through NUXT_EVOLUTION_DATABASE_URL and must not carry an override.
      evolution_db_url: server?.dbUrl ?? '',
      label: label?.trim() || 'WhatsApp account',
    })
  } catch (error) {
    await admin(`/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    throw error
  }

  // Deliberately non-fatal, and deliberately outside the compensating-delete
  // block rather than inside it. A connection that exists in both systems is a
  // working connection; tearing down a real Evolution instance over a missing
  // alert subscription would be the wrong trade. The hourly sweep re-asserts it.
  await registerConnectionWebhook(record).catch((error) => {
    console.error(`[instances] could not register the webhook for ${record.id} (${record.name}):`, error)
  })

  return record
}

let webhookUrlWarned = false

/**
 * Subscribe this connection's Evolution instance to `CONNECTION_UPDATE`.
 *
 * Per-instance rather than global, for two separate reasons:
 *
 * - The **global** webhook sends no custom headers at all, so
 *   `NUXT_WEBHOOK_SECRET` could never be satisfied by it — setting the secret
 *   made every delivery 401, and Evolution drops a 401 rather than retrying. A
 *   per-instance webhook does send `headers`, which is what makes the secret
 *   usable at all.
 * - A connection on a **bring-your-own** Evolution server has no
 *   `WEBHOOK_GLOBAL_URL` pointing at this deployment, and no reason to: it is
 *   the user's own server. Without this call those connections would deliver
 *   nothing, and their owners would be the only ones not told when they broke.
 *
 * Uses the instance's own token. Evolution's guard accepts it for this route, so
 * the no-global-key rule in `credentialsForInstance()` is not in play.
 *
 * Idempotent — upstream `set` upserts on the instance — so the sweep can call it
 * every hour to heal a registration that was never made, or that was lost with
 * the server it lived on.
 */
export async function registerConnectionWebhook(instance: AppInstance): Promise<void> {
  const { webhookUrl, webhookSecret } = useRuntimeConfig()

  if (!webhookUrl) {
    if (!webhookUrlWarned) {
      webhookUrlWarned = true
      console.warn(
        '[instances] NUXT_WEBHOOK_URL is not set, so connections are not subscribed to '
        + 'Evolution connection events. Disconnect alerts still work, but only as fast '
        + 'as the five-minute sweep.',
      )
    }
    return
  }

  // Absent for a Postgres connection, and for a WhatsApp row that never finished
  // provisioning. Neither has anything to subscribe.
  const creds = credentialsForInstance(instance)
  if (!creds) return

  const evolution = createEvolutionClient(creds)

  await evolution(`/webhook/set/${encodeURIComponent(instance.name)}`, {
    method: 'POST',
    body: {
      webhook: {
        enabled: true,
        url: webhookUrl,
        // Sent verbatim on every per-instance delivery. Empty when no secret is
        // configured, which leaves the route unauthenticated — see
        // server/api/webhook/evolution.post.ts for why that is survivable.
        headers: webhookSecret ? { 'x-webhook-secret': webhookSecret } : {},
        // One URL for every event, not one path per event.
        byEvents: false,
        base64: false,
        // Only this one. `MESSAGES_UPSERT` would deliver every message this
        // account receives to an endpoint that has no use for them.
        events: ['CONNECTION_UPDATE'],
      },
    },
  })
}

/**
 * Health of one connection, whatever kind it is.
 *
 * `state` uses the same four values for both kinds so the listing can render a
 * badge without branching: a database that answers is `open`, one that does not
 * is `close`, and a row with no DSN at all is `unknown` — the same shape as a
 * WhatsApp account that Evolution cannot be asked about.
 *
 * A type alias, not an interface, for the reason `InstanceStatus` gives.
 */
export type ConnectionHealth = {
  state: ConnectionState
  /** Human-readable line for the card: profile name, or database and version. */
  detail?: string
  error?: string
  /** Connected, but something the user should know: a role too privileged to scope. */
  warning?: string
}

export async function getPostgresHealth(instance: AppInstance): Promise<ConnectionHealth> {
  if (!instance.dsn) return { state: 'unknown', error: 'No connection string is stored for this database.' }

  try {
    const identity = await sqlIdentity(instance)
    return {
      state: 'open',
      // `identity.server` already names the engine, so this line reads
      // correctly for whichever one answered.
      detail: identity ? `${identity.server} · ${identity.database}` : undefined,
      warning: identity?.privilegeWarning,
    }
  }
  catch (cause) {
    // The DSN carries a password and the driver's message can echo connection
    // parameters, so only the code is surfaced. Logged here because a handled
    // error is invisible to Nitro and "it just says disconnected" is not a
    // diagnosis.
    console.error(`[pg] health check failed for instance ${instance.id}`, cause)
    const detail = (cause as { statusCode?: number, message?: string })
    return {
      state: 'close',
      error: detail?.statusCode === 422
        ? detail.message
        : `Could not reach the database (${(cause as { code?: string })?.code ?? 'connection failed'}).`,
    }
  }
}

/**
 * Record a Postgres connection.
 *
 * Nothing is provisioned: the database already exists and belongs to the user.
 * But the DSN is proved to work *before* the row is written, so a typo is a
 * failed create with a message about the connection string rather than a row
 * that looks connected and fails every later tool call. That is the same
 * ordering rule as the WhatsApp path, arrived at from the other direction —
 * there, the remote thing is made first because it is the part that can leak.
 *
 * `name` is generated for a Postgres row too. It reaches no external system
 * here, but `instances.name` is required and uniquely indexed, and leaving one
 * kind out of that would make every query that touches `name` conditional.
 */
export interface PostgresProvisionInput {
  label?: string
  dsn: string
}

export async function provisionPostgresInstance(
  actor: Actor,
  input: PostgresProvisionInput,
): Promise<AppInstance> {
  const dsn = input.dsn.trim()
  const { fields, probe } = await postgresFields(dsn)

  return await insertRow<AppInstance>('instances', {
    org: actor.org.id,
    created_by: actor.user.id,
    kind: 'postgres',
    name: generateInstanceName(),
    ...fields,
    label: input.label?.trim() || probe.database || 'Database',
  })
}

/**
 * Prove a DSN and build the columns that go with it.
 *
 * The secret and its display-only mirrors are written together, in one place,
 * so a new mirror cannot be added to the create path and forgotten on the
 * update path — a miss there is silent, leaving a row that simply lacks the
 * field.
 */
async function postgresFields(dsn: string) {
  // Parses, runs the host guard, connects, and reports the role's privileges.
  const probe = await probePgConnection(dsn)
  const target = describeDsn(dsn)

  return {
    probe,
    fields: {
      dsn,
      db_host: target.host,
      db_port: target.port,
      db_database: probe.database,
    },
  }
}

/** Rotate a database connection's DSN. Every token on it keeps working. */
export async function updatePostgresDsn(instance: AppInstance, dsn: string): Promise<AppInstance> {
  const { fields } = await postgresFields(dsn)

  const updated = await updateRow<AppInstance>('instances', instance.id, fields)

  // Drop the pool so the change takes effect now rather than at the next
  // fingerprint check. Belt and braces — `withPg` would notice on its own.
  await closeSqlPool(instance)

  return updated
}

/**
 * Record an IMAP mailbox. Like Postgres, nothing is provisioned — but the
 * credentials are proved by logging in *before* the row is written, so a wrong
 * app password is a failed create rather than a connection that syncs nothing.
 * The first sync starts at once rather than at the next two-minute tick.
 */
export interface ImapCredentialsInput {
  host: string
  port: number
  security: ImapSecurity
  user: string
  password: string
}

export async function provisionImapInstance(
  actor: Actor,
  input: ImapCredentialsInput & { label?: string },
): Promise<AppInstance> {
  const fields = await imapFields(input)

  const instance = await insertRow<AppInstance>('instances', {
    org: actor.org.id,
    created_by: actor.user.id,
    kind: 'imap',
    name: generateInstanceName(),
    ...fields,
    label: input.label?.trim() || fields.imap_user,
  })
  await requestImapSync(instance).catch(cause => console.error(`[imap] first sync of ${instance.id} did not start`, cause))
  return instance
}

/**
 * Replace a mailbox's credentials. Tokens keep working, as for a DSN. When the
 * new login names a different mailbox, everything synced from the old one is
 * deleted first — headers from one person's inbox must not appear under
 * another's.
 */
export async function updateImapCredentials(instance: AppInstance, input: ImapCredentialsInput): Promise<AppInstance> {
  const fields = await imapFields(input)

  const updated = await updateRow<AppInstance>('instances', instance.id, fields)
  await resetIfIdentityChanged(updated, { host: fields.imap_host, user: fields.imap_user })
  // New credentials end any stop an old, refused password put on the sync.
  const sql = await appDb()
  await sql`UPDATE app.mail_sync_state SET auth_failed = false WHERE instance_id = ${instance.id}`
  await closeImapFor(instance)
  await requestImapSync(updated).catch(cause => console.error(`[imap] sync of ${instance.id} did not start`, cause))
  return updated
}

/** Prove the credentials and build the columns that hold them, for create and update alike. */
async function imapFields(input: ImapCredentialsInput) {
  const target: ImapTarget = {
    host: input.host.trim(),
    port: input.port,
    security: input.security,
    user: input.user.trim(),
    password: input.password,
  }
  await probeImapConnection(target)
  return {
    imap_host: target.host,
    imap_port: target.port,
    imap_security: target.security,
    imap_user: target.user,
    imap_password: target.password,
  }
}

/**
 * A mailbox's state, from what the sync last saw rather than a fresh login.
 *
 * The dashboard polls this, and a login every thirty seconds per open tab is
 * exactly the traffic that gets an account rate-limited. The sync logs in every
 * two minutes regardless, so its outcome *is* a recent live observation; how
 * recent is reported, and a sync that has gone quiet reads as `unknown`, not
 * as healthy.
 */
export async function getImapHealth(instance: AppInstance): Promise<ConnectionHealth> {
  if (!imapTargetOf(instance)) return { state: 'unknown', error: 'No mailbox credentials are stored for this connection.' }

  const state = await mailSyncState(instance)
  if (!state?.lastAttemptAt) return { state: 'connecting', detail: 'Waiting for the first sync.' }
  if (state.authFailed) return { state: 'close', error: imapErrorMessage('auth') }

  const failedLast = state.lastErrorAt && (!state.lastSuccessAt || state.lastErrorAt > state.lastSuccessAt)
  if (failedLast) return { state: 'close', error: imapErrorMessage(state.lastErrorCode ?? 'connection failed') }

  if (!state.lastSuccessAt) return { state: 'connecting', detail: 'The first sync is running.' }
  const age = Date.now() - Date.parse(state.lastSuccessAt)
  if (age > 15 * 60_000) {
    return { state: 'unknown', detail: `Last synced ${Math.round(age / 60_000)} minutes ago.` }
  }
  return { state: 'open', detail: `Synced ${Math.max(0, Math.round(age / 60_000))} min ago` }
}

/**
 * Connection state, profile and counts — what the dashboard, the listing and
 * `get-connection-status` show. The alert paths, which need no counts, use
 * `getInstanceHealth` instead.
 *
 * An unpaired or unknown instance reports `close` and zeroes rather than
 * throwing, because the dashboard should render for an account that has never
 * been paired.
 *
 * **The state does not come from Evolution's row.** Its `connectionStatus` is
 * Evolution's database column, and 2.3.7 writes that column only when a socket
 * opens and when one closes for a reason it will not retry (logged out,
 * forbidden, 402, 406). Every other close — a lost network, a server-side
 * termination — takes the retry path, which updates only the in-memory state.
 * When that retry never lands, the column says `open` indefinitely over a dead
 * socket, and a badge read from it says Connected for an account that has
 * received nothing for days. That was a reported bug. `GET
 * /instance/connectionState` reads the in-memory state, so it is asked
 * alongside; the row still supplies the profile.
 *
 * If that second read fails the state is `unknown`, never the column's value —
 * falling back to the column is the bug.
 *
 * `sessionLost` is the disagreement between the two, and it is what tells a
 * dropped session from an account with no session at all. A fresh instance and
 * a logout both leave the column `close`, and a QR on screen leaves it
 * `connecting`; only a retried close leaves it `open` with nothing live behind it.
 *
 * **Where the row and the counts come from — and why not `fetchInstances`.**
 * That route answers with Prisma's `_count`, which counts every account's rows
 * and joins the result to this one: a full scan of `"Message"` per call, 42% of
 * production's block reads before this changed. So, when this connection has a
 * message database (`canReadMessages`):
 *
 *   - the row is a primary-key lookup on `"Instance"` (`readInstanceRecord`),
 *     uncached, so `sessionLost` is as fresh as the poll asking;
 *   - the counts are per account (`countInstanceRows`) and cached for
 *     `COUNTS_TTL_MS` — still ~100 ms on a large account, too much for a 15 s
 *     poll. `freshCounts` bypasses that (down to a 2 s floor) for the one screen
 *     that watches counts move: the history import after pairing.
 *
 * Without a message database — a bring-your-own server with no database URL —
 * or when that SQL fails, `fetchInstances` is still asked, but cached per
 * connection (`cachedApiRow`). That is the only path on which the row can be
 * stale; see there. One SQL failure never takes that path: a count that is
 * merely slow (statement timeout, or the account's slot busy) answers with the
 * last counts or none — swapping one account's slow count for a scan of every
 * account is the wrong trade (#156).
 */
export async function getInstanceStatus(
  instance: AppInstance,
  options: { freshCounts?: boolean } = {},
): Promise<InstanceStatus> {
  const { rowChurn: _churn, ...status } = await readStatus(instance, { counts: true, freshCounts: options.freshCounts })
  return status
}

export type InstanceHealth = Omit<InstanceStatus, 'stats'> & {
  /**
   * The churn observation after this read, for `evaluateConnectionHealth` to
   * store — the only writer of `row_churn_since` / `row_churn_seen_at`. Not on
   * `InstanceStatus`: the dashboard and MCP get the verdict, `flapping`.
   */
  rowChurn: RowChurn
}

/**
 * `getInstanceStatus` without the counts: state, `sessionLost`, `flapping`, `stalled`,
 * `ownerJid`, profile. For the alert sweep and webhook evaluation, which run
 * once per connection every few minutes and read none of the counts — so they
 * never cause one to be computed.
 */
export async function getInstanceHealth(instance: AppInstance): Promise<InstanceHealth> {
  const { stats: _stats, ...health } = await readStatus(instance, { counts: false })
  return health
}

// ── pairing, recorded ──────────────────────────────────────────────────────
/**
 * How long a WhatsApp connection may exist without ever being paired before
 * `reapUnpairedConnections` deletes it. It is not inert while it waits:
 * Evolution keeps it `connecting` and generates a fresh QR every few minutes
 * (each printed to Evolution's log), holds a socket for it, and auto-connects
 * it again at every Evolution boot; it also counts against `max_connections`.
 */
export const UNPAIRED_TTL_MS = 60 * 60_000

/** When a never-paired WhatsApp connection is due for removal; `undefined` once paired. */
export function unpairedRemovalAt(instance: AppInstance): string | undefined {
  if (instanceKind(instance) !== 'whatsapp' || instance.paired_at || !instance.created) return undefined
  const created = Date.parse(instance.created)
  return Number.isNaN(created) ? undefined : new Date(created + UNPAIRED_TTL_MS).toISOString()
}

/**
 * Record, once, that this WhatsApp account has been linked — `paired_at`.
 *
 * **Ours, because Evolution's own record cannot say it.** A connection nobody
 * has scanned yet and one that was logged out both leave Evolution's column
 * `close` with no `ownerJid`; only a fact written here while the account was
 * linked tells them apart, and the reaper deletes on exactly that difference.
 *
 * Called from every live read that can see a link — `readStatus` (dashboard,
 * MCP status, alert sweep, webhook) and the pairing page's QR poll. Fire and
 * forget: the conditional UPDATE makes repeats harmless, and a failed write is
 * retried by the next read, long before the hour runs out. The in-memory set
 * only saves the write on a process that already made it.
 */
export function notePaired(instance: AppInstance): void {
  if (instance.paired_at || pairedNoted.has(instance.id)) return
  pairedNoted.add(instance.id)
  storePaired(instance)
    .catch((error) => {
      pairedNoted.delete(instance.id)
      console.error(`[instances] could not record that connection ${instance.id} is paired:`, error)
    })
}

const pairedNoted = new Set<string>()

/** Like `notePaired`, but awaited — for the reaper, which acts on the answer. */
async function storePaired(instance: AppInstance): Promise<void> {
  const sql = await appDb()
  await sql`UPDATE app.instances SET paired_at = now() WHERE id = ${instance.id} AND paired_at IS NULL`
  pairedNoted.add(instance.id)
}

/**
 * Has this WhatsApp connection ever been paired — asked live, right before the
 * reaper deletes it. Records `paired_at` when the answer is yes.
 *
 *   paired    Evolution's live state is `open`, its row carries an `ownerJid`,
 *             or its database holds messages for the account. `ownerJid`
 *             survives a logout: 2.3.7 writes it only when the socket opens and
 *             never clears it (logout's `cleaningUp` sets `connectionStatus`
 *             alone). The messages check is a second line for a row that lost
 *             it some other way.
 *   unpaired  Evolution answered, and none of the above. Includes Evolution
 *             no longer knowing the instance at all (404).
 *   unknown   Something could not be asked. Never deleted on.
 *
 * Every read here is uncached. The status caches exist to spare dashboards;
 * this runs once per candidate per ten minutes and decides a deletion.
 *
 * **404 means gone — verified against 2.3.7.** The instance routes run
 * `[instanceExistsGuard, instanceLoggedGuard, authGuard.apikey]` in that order
 * (`src/api/routes/index.router.ts`), and `instanceExistsGuard` throws
 * `NotFoundException` when the name is neither loaded nor in `"Instance"` — so a
 * deleted instance answers 404 before its (now unknown) token is checked. The
 * one exception is `CACHE_REDIS_SAVE_INSTANCES=true`, where a stale Redis key
 * passes that guard and the auth guard answers 401; that reads as `unknown`
 * here and the row is kept. Every compose file and the AIO image set it false.
 */
export async function pairingEvidence(instance: AppInstance): Promise<'paired' | 'unpaired' | 'unknown'> {
  if (instance.paired_at) return 'paired'

  let evolution: EvolutionClient
  try {
    evolution = evolutionClientForInstance(instance)
  }
  catch {
    // No instance token: provisioning stores one before the row exists, so this
    // is a row that was edited by hand. Not ours to guess about.
    return 'unknown'
  }

  let missing = false
  try {
    if (await liveConnectionState(evolution, instance) === 'open') {
      await storePaired(instance)
      return 'paired'
    }
  }
  catch (error) {
    if (httpStatusOf(error) !== 404) return 'unknown'
    missing = true
  }

  // The row's ownerJid: from SQL where there is a message database, else from
  // Evolution's API. A 404 from either agrees with the live read that the
  // instance is gone; anything else is a read that failed.
  const canAskSql = canReadMessages(instance) && Boolean(instance.instance_id || !missing)
  let ownerJid: string | undefined
  let rowRead = false
  if (canAskSql) {
    try {
      const record = await readInstanceRecord(instance)
      if (record) {
        ownerJid = record.ownerJid
        rowRead = true
      }
    }
    catch {
      // Falls through to the API.
    }
  }
  if (!rowRead && !missing) {
    try {
      const rows = await evolution<EvolutionInstanceRow[]>('/instance/fetchInstances')
      const row = Array.isArray(rows) ? rows.find(r => r?.name === instance.name) : undefined
      if (!row) return 'unknown'
      ownerJid = row.ownerJid ?? undefined
    }
    catch (error) {
      if (httpStatusOf(error) !== 404) return 'unknown'
    }
  }
  if (ownerJid) {
    await storePaired(instance)
    return 'paired'
  }

  // Stored history outlives a logout. Without a message database there is
  // nothing to ask, and `paired_at` plus the reads above have to do. Whether a
  // message exists, not how many: one index probe rather than a count (#156).
  if (canAskSql) {
    try {
      if (await hasInstanceMessages(instance)) {
        await storePaired(instance)
        return 'paired'
      }
    }
    catch {
      return 'unknown'
    }
  }

  return 'unpaired'
}

// ── reconnect loops ────────────────────────────────────────────────────────
/**
 * How recently Evolution must have written an `open` row for the read to count
 * as "a socket just opened". A loop writes it about once a second; one ordinary
 * reconnect writes it once, and stops counting this long afterwards.
 */
const ROW_RECENT_MS = 2 * 60_000
/**
 * How long recent writes must keep being seen before the connection is called
 * `flapping`. Two sweeps five minutes apart can each land just after an
 * ordinary reconnect; three in a row that all do is a socket that will not
 * settle. Also the gap in observation after which an episode starts over.
 */
const CHURN_CONFIRM_MS = 10 * 60_000

/** First and latest evaluation that saw a recent `open` write. Both absent: none seen. */
export interface RowChurn {
  since?: string
  seenAt?: string
}

/**
 * Fold one status read into the stored churn observation, and say whether it
 * now amounts to a reconnect loop.
 *
 * **Why this exists.** Evolution 2.3.7 retries every close except `loggedOut`,
 * `forbidden`, 402 and 406 — at once, with no backoff and no attempt count —
 * and `createClient` replaces `this.client` without ending the previous socket,
 * whose handlers still reconnect when it closes. Two sockets on one set of
 * credentials then replace each other (`conflict: replaced`, 440) dozens of
 * times a minute, indefinitely. The column reads `open` throughout and every
 * live read lands on whichever socket just opened, so `state` and `sessionLost`
 * both say healthy. Production ran like that for hours and nobody was told
 * (ju-li/automata-mcp#103). Only restarting the Evolution service ends it.
 *
 * **The signal is Evolution's own row, never the webhook.** Each open writes
 * the `"Instance"` row, so `updatedAt` on an `open` row trails the newest open
 * — see `readInstanceRowWrittenAt`. A count of `connection.update`
 * deliveries would say the same thing, but deliveries are unsigned and anyone
 * can post one; a stranger must not be able to mail a user that their account
 * is unstable. The webhook still matters: it makes evaluations happen, which is
 * what refreshes the observation between sweeps.
 *
 * The rule, on time rather than on sample count so the webhook's extra
 * evaluations cannot shorten it: a recent write starts an episode, every later
 * one extends it, any read that sees no recent write ends it. `flapping` once
 * an episode has been extended for `CHURN_CONFIRM_MS` and was last extended
 * within that long. A read that cannot see the write time at all — no message
 * database, a missing grant, the SQL failing — leaves the observation as it
 * was, and the last clause lets a stale one lapse on its own.
 */
export function rowChurn(
  stored: RowChurn,
  read: { columnOpen: boolean, rowWrittenAt?: string },
  now = Date.now(),
): { churn: RowChurn, flapping: boolean } {
  const churn = nextChurn(stored, read, now)
  return { churn, flapping: isFlapping(churn, now) }
}

/** The verdict half of `rowChurn`, for a stored observation with no new read. */
export function isFlapping(churn: RowChurn, now = Date.now()): boolean {
  const since = churn.since ? Date.parse(churn.since) : Number.NaN
  const seenAt = churn.seenAt ? Date.parse(churn.seenAt) : Number.NaN
  return seenAt - since >= CHURN_CONFIRM_MS && now - seenAt < CHURN_CONFIRM_MS
}

function nextChurn(stored: RowChurn, read: { columnOpen: boolean, rowWrittenAt?: string }, now: number): RowChurn {
  const writtenAt = read.rowWrittenAt ? Date.parse(read.rowWrittenAt) : Number.NaN
  if (Number.isNaN(writtenAt)) return stored

  if (!read.columnOpen || now - writtenAt >= ROW_RECENT_MS) return {}

  const lastSeen = stored.seenAt ? Date.parse(stored.seenAt) : Number.NaN
  const continuing = stored.since !== undefined && now - lastSeen < CHURN_CONFIRM_MS
  const at = new Date(now).toISOString()
  return { since: continuing ? stored.since : at, seenAt: at }
}

// ── dead sockets under a live `open` ────────────────────────────────────────
/**
 * How long dead-socket evidence counts when the read cannot see when Evolution
 * last wrote the row — a failed or denied `"updatedAt"` read on a connection
 * that has a message database. Long enough to ride out one failed read, short
 * enough that evidence nobody can check against a reopen lapses on its own.
 */
const STALL_UNCHECKED_MS = 30 * 60_000
/**
 * Clock allowance between Evolution's `updatedAt` (its own host's clock, set by
 * Prisma) and `socket_dead_seen_at` (the app database's `now()`). A reopen
 * written within this of the evidence counts as after it: a send that lands in
 * a brief drop Evolution recovers from by itself must not read as a stuck
 * session. Evidence from a socket that died again right after reopening is
 * written once more a minute later, which is past this.
 */
const STALL_CLOCK_SKEW_MS = 30_000

/**
 * Judge the stored dead-socket evidence (socket-evidence.ts) against one status
 * read: is Evolution's session for this account stuck — `stalled` — and is the
 * evidence spent?
 *
 *   - Only an account that reads `open` live **and** stored can be stalled.
 *     Anything else is an ordinary outage `state` / `sessionLost` already
 *     reports; a known non-`open` live state also spends the evidence, since
 *     the socket that failed is gone and a reopen starts afresh.
 *   - A row written after the evidence (less `STALL_CLOCK_SKEW_MS`) means
 *     Evolution opened a socket since — a restart, a Reconnect, its own retry —
 *     so the evidence is about a socket that no longer exists: spent. 2.3.7
 *     writes the `"Instance"` row on every open (see `rowChurn`), and a stuck
 *     session writes nothing, which is what makes this the test.
 *   - No message database at all: never stalled. Nothing could tell a stuck
 *     session from a brief drop that already recovered, and mailing an
 *     organization about the second is the wrong trade — `flapping` makes the
 *     same one.
 *   - A message database whose write time this read could not get: the
 *     evidence alone, for `STALL_UNCHECKED_MS`, so one failed read neither
 *     ends an alerted episode (a false "connected again") nor keeps an old one
 *     alive for ever.
 *
 * Pure: the caller clears spent evidence (`forgetSocketEvidence`).
 */
export function socketStalled(
  seenAt: string | undefined,
  read: { live?: ConnectionState, columnOpen: boolean, canReadRow: boolean, rowWrittenAt?: string },
  now = Date.now(),
): { stalled: boolean, spent: boolean } {
  const seen = seenAt ? Date.parse(seenAt) : Number.NaN
  if (Number.isNaN(seen)) return { stalled: false, spent: false }

  if (read.live !== 'open' || !read.columnOpen) {
    const knownDown = read.live === 'close' || read.live === 'connecting'
    return { stalled: false, spent: knownDown }
  }
  if (!read.canReadRow) return { stalled: false, spent: false }

  const writtenAt = read.rowWrittenAt ? Date.parse(read.rowWrittenAt) : Number.NaN
  if (Number.isNaN(writtenAt)) return { stalled: now - seen < STALL_UNCHECKED_MS, spent: false }
  if (writtenAt > seen - STALL_CLOCK_SKEW_MS) return { stalled: false, spent: true }
  return { stalled: true, spent: false }
}

/** Drop what this module has cached about one connection. */
export function forgetInstanceStatus(instanceId: string): void {
  apiRowCache.delete(instanceId)
  countsCache.delete(instanceId)
  historySettingCache.forget(instanceId)
  holdRefreshedAt.delete(instanceId)
}

type InstanceStats = NonNullable<InstanceStatus['stats']>

async function readStatus(
  instance: AppInstance,
  options: { counts: boolean, freshCounts?: boolean },
): Promise<InstanceHealth & { stats?: InstanceStats }> {
  const evolution = evolutionClientForInstance(instance)
  const viaSql = canReadMessages(instance)
  const storedChurn: RowChurn = { since: instance.row_churn_since, seenAt: instance.row_churn_seen_at }

  const [live, record, rowWrittenAt, sqlCounts] = await Promise.all([
    liveConnectionState(evolution, instance).catch(() => undefined),
    viaSql ? sqlInstanceRecord(instance) : undefined,
    viaSql ? sqlRowWrittenAt(instance) : undefined,
    viaSql && options.counts ? cachedSqlCounts(instance, Boolean(options.freshCounts)) : undefined,
  ])

  let row: EvolutionInstanceRecord | undefined = record
  let stats = sqlCounts?.stats
  // No SQL counts at all (no message database, counts not asked for) or a
  // failed count that `fetchInstances` may stand in for. A slow count may not.
  const countsFromApi = options.counts && !stats && (sqlCounts?.fallback ?? true)
  if (!row || countsFromApi) {
    const api = await cachedApiRow(instance, evolution, live, Boolean(options.freshCounts))
    row ??= api
    if (options.counts) stats ??= api && statsFromApiRow(api)
  }

  if (!row) {
    // Evolution answered, but not about an account it recognises.
    return { state: 'close', rowChurn: storedChurn }
  }

  if (live === 'open' || row.ownerJid) notePaired(instance)

  const { churn, flapping } = rowChurn(storedChurn, {
    columnOpen: row.connectionStatus === 'open',
    rowWrittenAt,
  })

  // A loop is the stronger diagnosis and names the same fix; reporting both
  // would only say it twice.
  const socket = socketStalled(instance.socket_dead_seen_at, {
    live,
    columnOpen: row.connectionStatus === 'open',
    canReadRow: viaSql,
    rowWrittenAt,
  })
  if (socket.spent && instance.socket_dead_seen_at) forgetSocketEvidence(instance.id, instance.socket_dead_seen_at)
  const stalled = socket.stalled && !flapping

  return {
    state: live ?? 'unknown',
    sessionLost: row.connectionStatus === 'open' && live !== undefined && live !== 'open',
    flapping,
    ...(stalled && { stalled: true }),
    ...((flapping || stalled) && operatorAlertedAboutLoop(instance) && { operatorAlerted: true }),
    rowChurn: churn,
    profileName: row.profileName ?? undefined,
    profilePicUrl: row.profilePicUrl ?? undefined,
    number: row.number ?? row.ownerJid?.split('@')[0],
    ownerJid: row.ownerJid ?? undefined,
    disconnectedAt: row.disconnectionAt ?? undefined,
    stats,
  }
}

// ── status caches ──────────────────────────────────────────────────────────
// Per process, keyed on the connection id. Several replicas each keep their own,
// which only multiplies a bounded cost; nothing here is a correctness boundary.

const COUNTS_TTL_MS = 5 * 60_000
/** How fresh "fresh" is: two import-screen polls in a row share one count. */
const FRESH_FLOOR_MS = 2_000
const API_ROW_TTL_MS = 5 * 60_000
/** See `cachedApiRow`: a cached column that disagrees with the live state is re-read sooner. */
const API_ROW_DISAGREE_TTL_MS = 60_000

const countsCache = new Map<string, { at: number, stats: InstanceStats }>()
const countsInFlight = new Map<string, Promise<InstanceStats>>()
const apiRowCache = new Map<string, { at: number, row: EvolutionInstanceRow }>()
const apiRowInFlight = new Map<string, Promise<EvolutionInstanceRow | undefined>>()

/** The SQL row, or `undefined` for "use the fallback" — never throws. */
async function sqlInstanceRecord(instance: AppInstance): Promise<EvolutionInstanceRecord | undefined> {
  if (sqlDenied('instance row', instance)) return undefined
  try {
    // No row under this id is not proof the instance is gone — `instance_id`
    // could be stale — so `undefined` sends the caller to the fallback, which
    // asks Evolution by name, as before.
    return await readInstanceRecord(instance)
  }
  catch (error) {
    noteSqlFallback('instance row', instance, error)
    return undefined
  }
}

/**
 * When Evolution last wrote the row, or `undefined` for "cannot tell" — never
 * throws. Uncached, like the row: a loop is told from one reconnect by how
 * recent this is. A missing grant on `"updatedAt"` is logged by
 * `noteSqlFallback` like the other status grants, and costs only flapping
 * detection — there is no fallback for it.
 */
async function sqlRowWrittenAt(instance: AppInstance): Promise<string | undefined> {
  if (sqlDenied('row write time', instance)) return undefined
  try {
    return await readInstanceRowWrittenAt(instance)
  }
  catch (error) {
    // No fallback behind this one, so the usual wording would be untrue.
    noteSqlFallback('row write time', instance, error, {
      denied: '[instances] the Evolution database role cannot read "Instance"."updatedAt", so a '
        + 'WhatsApp reconnect loop is not detected. Add it to the status grants in '
        + 'docs/whatsapp.md "Reading and searching messages".',
      failed: '[instances] could not read when Evolution last wrote an instance row; reconnect-loop detection skipped:',
    })
    return undefined
  }
}

/**
 * Per-account counts, cached for `COUNTS_TTL_MS`. Concurrent callers share one
 * query, as `contactDirectory()` does. `fallback` says whether `readStatus` may
 * ask `fetchInstances` for counts this could not give.
 *
 * A failed recount serves the previous value if there is one — counts that are
 * a few minutes old are still right enough for a dashboard, and falling back to
 * `fetchInstances` is the expensive thing this exists to avoid. Failures are not
 * cached, so the next read retries.
 *
 * **A slow count never falls back** (#156): the statement timeout, or this
 * account's slot already busy (`sharedPoolFor`'s 429). `fetchInstances` counts
 * every account's rows to answer for one, so a count too slow for one account
 * would become a scan of all of them — on the first read after every deploy,
 * when nothing is cached yet. It answers with the cached counts, or none, which
 * the dashboard shows as unavailable. Fallback stays for what it exists for: a
 * missing grant (42501) and a database that cannot be reached.
 *
 * A `fresh` read (the import screen) gets no stale counts on a slow count: a
 * repeated old total reads to it as "the import stopped moving".
 */
async function cachedSqlCounts(
  instance: AppInstance,
  fresh: boolean,
): Promise<{ stats?: InstanceStats, fallback: boolean }> {
  const cached = countsCache.get(instance.id)
  const maxAge = fresh ? FRESH_FLOOR_MS : COUNTS_TTL_MS
  if (cached && Date.now() - cached.at < maxAge) return { stats: cached.stats, fallback: false }
  if (sqlDenied('counts', instance)) return { fallback: true }

  let counting = countsInFlight.get(instance.id)
  if (!counting) {
    counting = countInstanceRows(instance)
      .then((stats) => {
        countsCache.set(instance.id, { at: Date.now(), stats })
        return stats
      })
      .finally(() => countsInFlight.delete(instance.id))
    countsInFlight.set(instance.id, counting)
  }

  try {
    return { stats: await counting, fallback: false }
  }
  catch (error) {
    if (isSlowCount(error)) {
      // Its own key, so a slow count's quiet window cannot hide a broken read's log.
      noteSqlFallback('slow counts', instance, error, slowCountWording(instance))
      return { stats: fresh ? undefined : cached?.stats, fallback: false }
    }
    noteSqlFallback('counts', instance, error)
    return { stats: cached?.stats, fallback: true }
  }
}

/** A count that ran out of time, or never got a turn — not a broken read. */
function isSlowCount(error: unknown): boolean {
  return isStatementTimeout(error) || httpStatusOf(error) === 429
}

/** Said once per five minutes like the others; no grant is involved. */
function slowCountWording(instance: AppInstance): SqlFallbackWording {
  const failed = `[instances] counting messages for connection ${instance.id} was too slow; `
    + 'serving the last counts (or none), not falling back to fetchInstances:'
  return { denied: failed, failed }
}

/**
 * `fetchInstances`, cached per connection — the fallback for a connection with
 * no message database, and for one whose SQL read failed.
 *
 * Still the expensive route, but at most once per window per connection rather
 * than once per poll, and for a bring-your-own server the cost lands on that
 * server.
 *
 * **The one place the row can be stale**, and it matters for `sessionLost`,
 * which compares the cached column against the live state. Bounded three ways:
 * our own logout, reconnect and delete drop the entry (`forgetInstanceStatus`);
 * a cached column that disagrees with the live state — a pairing that just
 * finished, a logout from the phone — is re-read after `API_ROW_DISAGREE_TTL_MS`
 * rather than the full window; and `fresh` (the import screen) re-reads it down
 * to the 2 s floor. A dropped session is a lasting disagreement, so it costs one
 * re-read a minute while it lasts.
 *
 * Failures are not cached and answer `undefined`, which the caller reports as
 * it always has.
 */
async function cachedApiRow(
  instance: AppInstance,
  evolution: EvolutionClient,
  live: ConnectionState | undefined,
  fresh: boolean,
): Promise<EvolutionInstanceRow | undefined> {
  const cached = apiRowCache.get(instance.id)
  const disagrees = cached !== undefined && live !== undefined
    && normalizeState(cached.row.connectionStatus) !== live
  const maxAge = fresh ? FRESH_FLOOR_MS : disagrees ? API_ROW_DISAGREE_TTL_MS : API_ROW_TTL_MS
  if (cached && Date.now() - cached.at < maxAge) return cached.row

  const inFlight = apiRowInFlight.get(instance.id)
  if (inFlight) return inFlight

  const fetching = evolution<EvolutionInstanceRow[]>('/instance/fetchInstances')
    .then((rows) => {
      const row = Array.isArray(rows) ? rows.find(r => r?.name === instance.name) ?? rows[0] : undefined
      if (row) apiRowCache.set(instance.id, { at: Date.now(), row })
      return row
    })
    .catch(() => undefined)
    .finally(() => apiRowInFlight.delete(instance.id))

  apiRowInFlight.set(instance.id, fetching)
  return fetching
}

function statsFromApiRow(row: EvolutionInstanceRow): InstanceStats {
  return {
    messages: row._count?.Message ?? 0,
    chats: row._count?.Chat ?? 0,
    contacts: row._count?.Contact ?? 0,
  }
}

/**
 * Say why a status read fell back to `fetchInstances` — once per cause per five
 * minutes, since the sweep and the polls would otherwise repeat it constantly.
 * The fallback keeps the status right, so without this a missing grant would
 * only show up as the database load this change exists to remove.
 *
 * A missing grant (42501) also stops that read being tried for the same five
 * minutes on that connection: it will not fix itself between two polls, and
 * each attempt is an error line in Postgres's own log.
 */
const SQL_FALLBACK_QUIET_MS = 5 * 60_000
const sqlFallbackLoggedAt = new Map<string, number>()
// Not cleared by `forgetInstanceStatus`: a missing grant is about the database
// role, not about anything a logout or reconnect changes.
const sqlDeniedAt = new Map<string, number>()

function sqlDenied(what: string, instance: AppInstance): boolean {
  const at = sqlDeniedAt.get(`${what}:${instance.id}`)
  return at !== undefined && Date.now() - at < SQL_FALLBACK_QUIET_MS
}

/** What a failed status read logs: a missing grant, or anything else. */
interface SqlFallbackWording {
  denied: string
  failed: string
}

function fetchInstancesFallback(what: string): SqlFallbackWording {
  return {
    denied: `[instances] status ${what}: the Evolution database role lacks a grant, so status reads `
      + 'fall back to Evolution\'s fetchInstances (a full "Message" scan, cached per connection). '
      + 'Add the status grants in docs/whatsapp.md "Reading and searching messages".',
    failed: `[instances] status ${what} could not be read from the Evolution database; using fetchInstances:`,
  }
}

function noteSqlFallback(
  what: string,
  instance: AppInstance,
  error: unknown,
  wording: SqlFallbackWording = fetchInstancesFallback(what),
): void {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === '42501') sqlDeniedAt.set(`${what}:${instance.id}`, Date.now())

  const key = `${what}:${String(code ?? 'other')}`
  const last = sqlFallbackLoggedAt.get(key)
  if (last !== undefined && Date.now() - last < SQL_FALLBACK_QUIET_MS) return
  sqlFallbackLoggedAt.set(key, Date.now())

  if (code === '42501') console.warn(wording.denied)
  else console.error(wording.failed, error)
}

/**
 * The state Evolution holds in memory for this instance's socket — the one that
 * is true, see `getInstanceStatus`. An instance Evolution has not loaded at all
 * answers with no state, which reads as `unknown`.
 */
async function liveConnectionState(evolution: EvolutionClient, instance: AppInstance): Promise<ConnectionState> {
  const response = await evolution<{ instance?: { state?: string } }>(
    `/instance/connectionState/${encodeURIComponent(instance.name)}`,
  )
  return normalizeState(response?.instance?.state)
}

/**
 * Bring a dropped session back from its stored credentials, without a QR scan
 * if they still hold.
 *
 * Only one live state has a call that does that safely:
 *
 *   close       `GET /instance/connect`. In `close` Evolution builds a new socket
 *               from the stored credentials.
 *   connecting  nothing — 409. `connect` in this state only returns the cached
 *               QR object, and the other candidate, `restart`, is never sent
 *               (below). A socket that hung while connecting is recovered by
 *               restarting the Evolution service, which is what the refusal says.
 *   unknown     nothing — 409. Evolution has no live socket it will tell us
 *               about; the same restart is the remedy.
 *   open        nothing. This is also the one state in which no call could help
 *               if the socket were in fact dead: Baileys' `end()` returns early
 *               on a socket it already closed.
 *
 * **Never `POST /instance/restart`.** On Baileys, 2.3.7's controller takes a
 * fallback branch (`instance.controller.ts` `restartInstance`) that calls
 * `client.end()` — a close with no status code, which Evolution's own close
 * handler answers by reconnecting — and then calls `connectToWhatsapp` itself.
 * When the close has been processed by then, that is a second `createClient`
 * beside the handler's, and `createClient` does not end the socket it replaces:
 * two sockets on one set of credentials, replacing each other as fast as they
 * can log in. It is a race, unconfirmed as the cause of
 * ju-li/automata-mcp#103, but the loop it can start costs a real number its
 * standing with WhatsApp, and in the order where it does not double up it does
 * nothing a service restart would not.
 *
 * `connect` can still leave the account needing a QR — rejected credentials
 * make Evolution emit one — which the caller sees as a state it can pair from.
 *
 * The route catches its own failures and answers **200** with
 * `{ error: true, message }`, so a resolved request is not a success.
 */
export async function reconnectInstance(instance: AppInstance): Promise<ConnectionState> {
  const evolution = evolutionClientForInstance(instance)
  const name = encodeURIComponent(instance.name)

  const before = await liveConnectionState(evolution, instance)
  if (before === 'open') return before
  if (before !== 'close') {
    throw createError({
      statusCode: 409,
      statusMessage: before === 'connecting'
        ? 'Evolution is still connecting this account. If it stays that way, restart the Evolution service — that reconnects it without a new QR scan.'
        : 'Evolution has no live connection for this account. Restarting the Evolution service reconnects it without a new QR scan.',
    })
  }
  if (!(await claimConnect(instance))) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This account was asked to connect a moment ago. Wait a few seconds and look again before trying once more.',
    })
  }
  forgetInstanceStatus(instance.id)

  const response = await evolution<EvolutionActionResponse>(`/instance/connect/${name}`)

  if (response?.error) {
    // Handled, so Nitro would log nothing; the message is Evolution's own.
    console.error(
      `[instances] reconnect of ${instance.id} (${instance.name}) from state ${before} failed: ${response.message}`,
    )
    throw createError({ statusCode: 502, statusMessage: 'Evolution could not reconnect this account' })
  }

  return await liveConnectionState(evolution, instance)
}

// ── asking Evolution to connect ────────────────────────────────────────────
/**
 * How long after the socket was last seen connecting or open — or after this
 * app last asked Evolution to connect — before `close` is taken at its word.
 * Covers the restart WhatsApp demands right after a QR scan with room to spare;
 * a QR that really expired waits this long for its replacement.
 */
const CONNECT_HOLD_MS = 15_000
/**
 * The pairing poll pushes the hold forward at most this often per process, so
 * two-second polls do not mean a write every two seconds. The hold then ends no
 * sooner than `CONNECT_HOLD_MS - HOLD_REFRESH_MS` after the last activity seen.
 */
const HOLD_REFRESH_MS = 5_000
const holdRefreshedAt = new Map<string, number>()

/**
 * Claim the right to send `GET /instance/connect` to an account Evolution
 * holds in `close`. False means something saw the socket alive, or asked for a
 * connect, within the hold — and the caller must not send it.
 *
 * **Why every `connect` we send goes through this.** In `close` that call makes
 * Evolution 2.3.7 build a new client (`connectToWhatsapp` → `createClient`),
 * and `createClient` never ends the socket it replaces. Evolution also calls
 * `connectToWhatsapp` itself on every close it retries — notably the stream
 * error 515 WhatsApp sends right after a QR scan, whose `close` lasts a moment
 * before Evolution's own reconnect lands. A `connect` from us in that moment is
 * a second socket on the same credentials; the two replace each other until the
 * service restarts, which is the reconnect loop `flapping` reports, starting
 * from the first minute of pairing (ju-li/automata-mcp#122; #103 is the same
 * loop by another route).
 *
 * Stored on the row, claimed by conditional UPDATE, so two tabs, a reload and
 * two replicas share one hold — memory in a browser or one process would not.
 * Plain SQL: `updated` is not bumped.
 */
async function claimConnect(instance: AppInstance): Promise<boolean> {
  const sql = await appDb()
  const holdSecs = CONNECT_HOLD_MS / 1000
  const rows = await sql`
    UPDATE app.instances
    SET connect_hold_until = now() + make_interval(secs => ${holdSecs})
    WHERE id = ${instance.id}
      AND (connect_hold_until IS NULL OR connect_hold_until < now())
    RETURNING id
  `
  if (rows.length) holdRefreshedAt.set(instance.id, Date.now())
  return rows.length > 0
}

/** The socket was just seen connecting or open: hold off any `connect`. */
async function extendConnectHold(instance: AppInstance): Promise<void> {
  const last = holdRefreshedAt.get(instance.id)
  if (last !== undefined && Date.now() - last < HOLD_REFRESH_MS) return
  const sql = await appDb()
  const holdSecs = CONNECT_HOLD_MS / 1000
  await sql`
    UPDATE app.instances
    SET connect_hold_until = now() + make_interval(secs => ${holdSecs})
    WHERE id = ${instance.id}
  `
  holdRefreshedAt.set(instance.id, Date.now())
}

/**
 * Lift the hold after we ended the session ourselves. A logout is a close
 * Evolution does not retry, so nothing on its side is about to reconnect, and
 * the pairing that follows should get its QR at once.
 */
async function releaseConnectHold(instance: AppInstance): Promise<void> {
  holdRefreshedAt.delete(instance.id)
  const sql = await appDb()
  await sql`UPDATE app.instances SET connect_hold_until = NULL WHERE id = ${instance.id}`
}

/**
 * Current QR, or the connection state once pairing has completed. The pairing
 * page polls this every two seconds.
 *
 * **Live state first, and `connect` only where it is safe.** `GET
 * /instance/connect` is what starts a connection and what hands out the QR, but
 * what it does depends on Evolution's in-memory state:
 *
 *   open        answers a state object. We do not call it: the state read
 *               already said so. Recorded as paired.
 *   connecting  returns the cached QR and does nothing else — safe, and the
 *               only way to get the QR, so it is called.
 *   close       builds a new socket. Called only through `claimConnect`: at the
 *               start of pairing (fresh instance, after a logout) the hold is
 *               free and the QR comes back at once; right after a scan, while
 *               Evolution reconnects by itself, the hold is still running and
 *               the poll answers `close` with no QR. A `close` that outlasts
 *               the hold — a QR that ran out — gets its connect then.
 *   unknown     nothing. A state Evolution does not name is not one to start a
 *               socket from.
 *
 * Residual window: the state read and the `connect` are two requests, so a
 * close landing between them still reaches Evolution as a connect in `close`.
 * It is milliseconds wide against the second-wide window this closes; shutting
 * it would need Evolution to stop leaking the socket it replaces.
 */
export async function getInstanceQr(instance: AppInstance): Promise<{ state: ConnectionState, qr?: InstanceQr }> {
  const evolution = evolutionClientForInstance(instance)

  const before = await liveConnectionState(evolution, instance)
  if (before === 'unknown') return { state: before }
  if (before === 'open') {
    await extendConnectHold(instance)
    // The pairing page's poll is the first thing to see a scan land.
    notePaired(instance)
    return { state: before }
  }
  if (before === 'connecting') await extendConnectHold(instance)
  else if (!(await claimConnect(instance))) return { state: 'close' }

  // Last, right before `connect`: in `close` it builds the socket that pairs,
  // and the history setting reaches Baileys only when a socket is built. After
  // the hold above, so a poll that will not connect costs nothing more.
  await applyHistoryLimitBeforePairing(instance)

  const response = await evolution<Record<string, any>>(
    `/instance/connect/${encodeURIComponent(instance.name)}`,
  )

  if (response?.instance?.state) {
    const state = normalizeState(response.instance.state)
    if (state === 'open') notePaired(instance)
    return { state }
  }

  if (response?.base64 || response?.code || response?.pairingCode) {
    return {
      state: 'connecting',
      qr: {
        base64: response.base64,
        code: response.code,
        pairingCode: response.pairingCode,
        count: response.count,
      },
    }
  }

  // Evolution returns an empty object in the moment between starting the
  // connection and the first QR being generated. Not an error — poll again.
  return { state: 'connecting' }
}

/**
 * End the WhatsApp session, keeping the instance and its token.
 *
 * Evolution answers 400 when the instance is already disconnected. That is the
 * state the caller asked for, so it is treated as success.
 */
export async function logoutInstance(instance: AppInstance): Promise<void> {
  const evolution = evolutionClientForInstance(instance)
  // Whatever happens below, the cached row (fallback path) predates it.
  forgetInstanceStatus(instance.id)
  try {
    await evolution(`/instance/logout/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
  } catch (error) {
    if (httpStatusOf(error) !== 400) throw error
  }
  // Best effort: a hold left running only delays the next QR by its length.
  await releaseConnectHold(instance).catch(error =>
    console.error(`[instances] could not release the connect hold of ${instance.id}:`, error))
}

/**
 * Turn on full-history sync, then drop the WhatsApp session so the next pairing
 * imports it.
 *
 * WhatsApp hands history over exactly once, during the initial login. An account
 * paired while `syncFullHistory` was off cannot be backfilled in place — Evolution
 * exposes no endpoint that fetches history after the fact. The only way in is to
 * log out and re-scan, which is why the setting and the logout are one call: the
 * setting alone does nothing, and the logout alone costs a QR scan on a real phone
 * for no gain.
 *
 * Callers must confirm with the user first. This disconnects the account.
 */
export async function enableFullHistorySync(instance: AppInstance): Promise<void> {
  // Before anything changes: refused, the account stays linked.
  if (await historyLimited(instance)) throw fullHistoryLimitError()

  await writeSyncFullHistory(instance, true)

  // The new setting only reaches Baileys when the socket is next constructed, and
  // that only counts as a fresh device link — the thing that triggers a history
  // sync — if the stored credentials are gone. Logging out removes them.
  await logoutInstance(instance)
}

/**
 * Destroy the instance: the Evolution instance and everything it stored, plus
 * the app's row. `mcp_tokens` rows cascade away with it, so every token
 * for this account stops authenticating.
 *
 * Evolution is torn down first — if that fails we keep the row, because a row
 * pointing at a live instance is recoverable and a live instance nobody has a
 * record of is not. Evolution logs the instance out itself if it is connected.
 *
 * A Postgres connection owns nothing outside this app: there is no remote
 * resource to release, only a local pool to close.
 *
 * `event` is the hosted outbox row for the delete, written in the same
 * transaction as the row delete.
 */
export async function deleteInstance(
  instance: AppInstance,
  options: { event?: HostedEvent } = {},
): Promise<void> {
  // Release whatever this kind holds, then delete the row — once, for every
  // kind. The ordering is the rule stated above and it is the same either way:
  // if releasing throws, the row survives and still points at the thing.
  const kind = instanceKind(instance)

  if (kind === 'telegram') {
    // Logs the account out on Telegram's side and deletes its synced chats.
    await deleteTelegramSession(instance)
  }
  else if (kind === 'postgres') {
    await closeSqlPool(instance)
  }
  else if (kind === 'imap') {
    // Nothing remote to release — the mailbox is the user's. The synced
    // headers go with the row (ON DELETE CASCADE); the live connection is ours.
    await closeImapFor(instance)
  }
  else if (kind === 'whatsapp') {
    // A connection on its own server may hold a pool onto that server's message
    // database. Keyed on the row, so it outlives the row unless dropped here.
    await closeKeyedPool(`evo:${instance.id}`)
    forgetInstanceStatus(instance.id)

    // Uses the same server the instance was created on, with that server's own
    // global key when it brought one.
    //
    // **Credentials missing is not a reason to refuse the delete.** With the
    // Evolution variables now optional, and with a row's `base_url` able to stop
    // matching a reconfigured deployment, `evolutionAdminCredentials` can
    // return undefined for a row that already exists — and gating the row
    // deletion on that would leave a connection, and its tokens, permanently
    // undeletable. Better a logged orphan on the Evolution server than a
    // record the owner cannot get rid of.
    const creds = evolutionAdminCredentials(instance)

    if (!creds) {
      console.error(
        `[instances] deleting ${instance.id} (${instance.name}) without tearing down its Evolution `
        + 'instance: no global key is available for its server. It may need removing there by hand.',
      )
    }
    else {
      try {
        await createEvolutionClient(creds)(`/instance/delete/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
      } catch (error) {
        // A 404 means Evolution has already lost it; carry on and clean up our row.
        if (httpStatusOf(error) !== 404) throw error
      }
    }
  }
  else {
    assertNever(kind, 'connection kind')
  }

  // The outbox event commits with the row delete, so it exists exactly when the
  // connection is gone.
  const sql = await appDb()
  await sql.begin(async (tx) => {
    await tx`DELETE FROM app.instances WHERE id = ${instance.id}`
    if (options.event) await recordHostedEvent(tx, options.event)
  })
}

/**
 * Whether this connection may import only recent history: its organization is
 * limited to that (`recent_history_only`, which the cloud service sets for
 * Free) **and** it lives on the deployment's own backend — Evolution server for
 * WhatsApp, bridge for Telegram. A bring-your-own backend stores history on the
 * user's disk, which is what the limit is about, so it never applies there.
 * `undefined` for kinds that import no history.
 *
 * The one place the rule lives for an existing connection: WhatsApp's
 * full-history import and pairing, Telegram's pairing
 * (`startTelegramPairing`) and the dashboard's `historyLimitedByPlan` ask here.
 * Creating a WhatsApp connection asks the same question before the row exists,
 * in `provisionWhatsappInstance`: no `server` there is exactly
 * `onDeploymentServer` here.
 */
export async function historyLimited(instance: AppInstance): Promise<boolean | undefined> {
  const kind = instanceKind(instance)
  let ownBackend: boolean
  switch (kind) {
    case 'whatsapp': ownBackend = onDeploymentServer(instance); break
    case 'telegram': ownBackend = onDeploymentBridge(instance); break
    case 'postgres':
    case 'imap': return undefined
    default: return assertNever(kind)
  }
  if (!ownBackend) return false
  return await orgRecentHistoryOnly(await appDb(), instance.org)
}

/**
 * Set `syncFullHistory` on the connection's Evolution instance. Answers whether
 * anything was written: a value already in place is left alone.
 *
 * Read-modify-write, never a partial write. Evolution's `setSettings` copies
 * every field of the body onto the live instance's in-memory settings, so a key
 * left out of the request becomes `undefined` there until the process restarts
 * — omitting `groupsIgnore` silently un-sets it on a running socket. Its schema
 * also *requires* all six booleans, so a partial body is a 400 anyway.
 * Not caught: `find` answers `null` when the instance has no settings row yet
 * (Evolution's default, off), so anything thrown here is a real failure.
 * Swallowing it would mean writing defaults over settings we failed to read.
 */
async function writeSyncFullHistory(instance: AppInstance, on: boolean): Promise<boolean> {
  const current = await readEvolutionSettings(instance)
  if ((current?.syncFullHistory === true) === on) return false

  await evolutionClientForInstance(instance)(`/settings/set/${encodeURIComponent(instance.name)}`, {
    method: 'POST',
    body: settingsBody(current, { syncFullHistory: on }),
  })
  historySettingCache.forget(instance.id)
  return true
}

/**
 * When each connection's history setting was last checked before pairing. The
 * QR poll runs every two seconds; one check a minute is enough, since the
 * setting matters only at the moment a socket is built.
 */
const historyLimitChecked = new Map<string, number>()
const HISTORY_LIMIT_CHECK_MS = 60_000
const MAX_HISTORY_LIMIT_CHECKED = 1000

/** The connection's Evolution settings; `null` when it has no settings row yet (Evolution's default). */
function readEvolutionSettings(instance: AppInstance): Promise<EvolutionSettings | null> {
  return evolutionClientForInstance(instance)<EvolutionSettings | null>(
    `/settings/find/${encodeURIComponent(instance.name)}`,
  )
}

/**
 * Turn `syncFullHistory` off before a limited connection pairs.
 *
 * A connection created under a limit already has it off. This covers the one
 * created with it on — by an organization that was unlimited then (a lapsed
 * Pro), or before the limit existed — which would otherwise import the full
 * history at its next pairing. One-directional on purpose: lifting the limit
 * turns nothing on. Full history then arrives only through "Import full
 * history", which the owner chooses because it costs a QR scan.
 *
 * Errors propagate, so the poll fails rather than pair with the setting unknown.
 */
async function applyHistoryLimitBeforePairing(instance: AppInstance): Promise<void> {
  const now = Date.now()
  const checked = historyLimitChecked.get(instance.id)
  if (checked && now - checked < HISTORY_LIMIT_CHECK_MS) return

  if (await historyLimited(instance) && await writeSyncFullHistory(instance, false)) {
    console.info(`[instances] ${instance.id} (${instance.name}): full-history sync turned off before pairing — the organization imports recent history only`)
  }

  rememberBounded(historyLimitChecked, instance.id, now, MAX_HISTORY_LIMIT_CHECKED)
}

/**
 * Whether this account's history was imported only in part: its Evolution
 * settings carry `syncFullHistory: false`, so its pairing asked WhatsApp for
 * the recent slice only. `undefined` when the settings could not be read —
 * callers then say nothing either way rather than guess.
 *
 * Read off the connection rather than the plan on purpose. The setting is what
 * the pairing actually used: an organization that upgraded but has not
 * re-imported still holds only recent history, and one that lapsed keeps the
 * full history it imported. Both stay true here because nothing changes the
 * setting except a pairing-bound step — `enableFullHistorySync` (which logs
 * out) and `applyHistoryLimitBeforePairing`. One looseness, in the safe
 * direction: a connection that imported in full and was then re-paired under
 * the limit holds the old history too, and still reads as partial.
 *
 * Also true for an account paired before `syncFullHistory` was turned on, which
 * is accurate: it has only what arrived since.
 *
 * Cached five minutes per connection (`sharedCache`: one read for concurrent
 * tool calls, successes only), cleared wherever the setting is written and by
 * `forgetInstanceStatus`.
 */
export async function recentHistoryOnly(instance: AppInstance): Promise<boolean | undefined> {
  try {
    // No settings row is Evolution's default, which is off.
    return await historySettingCache.get(instance.id, async () => (await readEvolutionSettings(instance))?.syncFullHistory !== true)
  }
  catch (error) {
    console.warn(`[instances] could not read history settings for ${instance.id} (${instance.name}):`, error)
    return undefined
  }
}

const historySettingCache = sharedCache<boolean>({ namespace: 'history-setting', ttlMs: 5 * 60_000 })

/**
 * Said to a model alongside `recentHistoryOnly: true`. Shared by the read and
 * search tools so the two cannot describe the gap differently.
 */
export const RECENT_HISTORY_NOTE
  = 'This account\'s history was imported only in part: when it was linked, WhatsApp handed over '
    + 'its recent history, not the full one, so older messages may never have been imported and '
    + 'cannot be read or searched here. The oldest message stored is not necessarily the start of '
    + 'a conversation, and finding nothing older is not proof nothing older exists — say so rather '
    + 'than presenting what is here as the whole history. An admin of the account can import the '
    + 'full history from its page in the web app, where their plan allows it.'

// ── internals ──────────────────────────────────────────────────────────────

/** One row of `fetchInstances` — the record `readInstanceRecord` reads, plus Prisma's counts. */
interface EvolutionInstanceRow extends EvolutionInstanceRecord {
  name?: string
  _count?: { Message?: number, Chat?: number, Contact?: number }
}

/** What `connect` and `restart` answer with when they failed — as a 200. */
interface EvolutionActionResponse {
  error?: boolean
  message?: string
}

interface EvolutionSettings {
  rejectCall?: boolean
  msgCall?: string | null
  groupsIgnore?: boolean
  alwaysOnline?: boolean
  readMessages?: boolean
  readStatus?: boolean
  syncFullHistory?: boolean
  wavoipToken?: string | null
}

/**
 * A settings body Evolution will accept.
 *
 * Its schema marks all six booleans `required`, and types `msgCall`/`wavoipToken`
 * as `string` — so a missing boolean is a 400, and a `null` string (which is what
 * `settings/find` returns for an unset one) is also a 400. Default the booleans,
 * drop the empty strings.
 */
function settingsBody(current: EvolutionSettings | null, overrides: Partial<EvolutionSettings>): Record<string, unknown> {
  const merged = { ...current, ...overrides }

  const body: Record<string, unknown> = {
    rejectCall: merged.rejectCall ?? false,
    groupsIgnore: merged.groupsIgnore ?? false,
    alwaysOnline: merged.alwaysOnline ?? false,
    readMessages: merged.readMessages ?? false,
    readStatus: merged.readStatus ?? false,
    syncFullHistory: merged.syncFullHistory ?? false,
  }

  if (merged.msgCall) body.msgCall = merged.msgCall
  if (merged.wavoipToken) body.wavoipToken = merged.wavoipToken

  return body
}

/**
 * Live state for one connection, whatever kind it is.
 *
 * The branch lives here rather than in the routes because both `/api/instances`
 * and `/api/instances/:id` were carrying their own copy of it, each choosing
 * between `getPostgresHealth` and `getInstanceStatus` and reshaping the result.
 * `instanceKind()` is the intended dispatch point for this; a route handler is
 * not, and two copies of a dispatch are two things to update when a third kind
 * arrives.
 *
 * `tolerant` is the one difference between the two callers, and it is real. A
 * listing must not lose every row because one is half-provisioned — an
 * unprovisioned WhatsApp row makes `evolutionClientForInstance` throw 409 —
 * whereas asking for one connection by id should say so. Note that neither
 * `getPostgresHealth` nor `getInstanceStatus` throws for a *backend* failure:
 * both already answer with a `close`/`unknown` state, which is what the
 * dashboard needs in order to render at all.
 *
 * A row that throws reports **`unknown`, not `close`**, and the two are not
 * interchangeable: `close` reads to a person as "not paired, scan a QR code",
 * which is a wrong instruction for a connection whose credentials never
 * existed. `unknown` says the state could not be established, which is the
 * truth, so `unknownStatus()` answers here and never a `close` one.
 */
export type ConnectionStateReport =
  | { state: ConnectionState, detail?: string, error?: string, warning?: string }
  | InstanceStatus
  | TelegramStatus

export async function connectionState(
  instance: AppInstance,
  options: { tolerant?: boolean, freshCounts?: boolean } = {},
): Promise<ConnectionStateReport> {
  const kind = instanceKind(instance)
  switch (kind) {
    case 'postgres': {
      const health = await getPostgresHealth(instance)
      return { state: health.state, detail: health.detail, error: health.error, warning: health.warning }
    }
    case 'whatsapp':
      if (!options.tolerant) return await getInstanceStatus(instance, { freshCounts: options.freshCounts })
      return await getInstanceStatus(instance, { freshCounts: options.freshCounts }).catch(() => unknownStatus())
    case 'telegram':
      // Never throws: a bridge that cannot be asked answers `unknown`, for the
      // reason given above.
      return await getTelegramStatus(instance)
    case 'imap':
      return await getImapHealth(instance)
    default:
      return assertNever(kind, 'connection kind')
  }
}

/** Evolution could not be asked at all — see `connectionState`. No counts: not measured is not zero. */
function unknownStatus(): InstanceStatus {
  return { state: 'unknown' }
}

function normalizeState(state: string | undefined): ConnectionState {
  return state === 'open' || state === 'connecting' || state === 'close' ? state : 'unknown'
}
