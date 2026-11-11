import type { AppInstance } from './app-db'
import type { McpAuth } from './mcp-auth'
import type { ConnectionState } from '#shared/connection'

/**
 * The one client for a Telegram bridge (apps/telegram-bridge). The Telegram
 * counterpart of `evolution.ts`, with the same boundary:
 *
 *   admin     the bridge's global key. Creates and deletes sessions and nothing
 *             else. Two callers, both in telegram-instances.ts. Either the
 *             deployment's own key, or a key the user supplied for their own
 *             bridge — never cross-paired, see `telegramAdminCredentials`.
 *   session   the per-session key the bridge issued, on the row's `api_key`.
 *             Pairing, state, resolve and send — every call made on a user's
 *             behalf.
 *
 * And the same cut across both: a base URL that is not this deployment's
 * `NUXT_TELEGRAM_URL` came from a user, so it is host-guarded on every request.
 *
 * Reading chats does not go through here. Messages are read from the bridge's
 * database, as `evolution-db.ts` reads Evolution's — see `telegram-db.ts`.
 */

export interface TelegramCredentials {
  baseUrl: string
  /** The bridge's per-session key. Opens only this session. */
  apiKey: string
  /** The bridge's id for this session (`instances.instance_id`). */
  sessionId: string
  /** True when `baseUrl` is not the bridge this deployment is configured with. */
  userSupplied: boolean
}

export interface TelegramAdminCredentials {
  baseUrl: string
  adminKey: string
  userSupplied: boolean
}

/**
 * Whether this connection lives on the bridge this deployment configured.
 *
 * The single test, as `onDeploymentServer` is for Evolution: a row carrying its
 * own admin key is definitively its own bridge, and so is one pointing anywhere
 * other than `NUXT_TELEGRAM_URL`. Origins are compared the way
 * `sameEvolutionServer` compares them, so a trailing slash does not turn a
 * deployment connection into a guarded one.
 */
export function onDeploymentBridge(instance: Pick<AppInstance, 'admin_key' | 'base_url'>): boolean {
  if (instance.admin_key) return false
  const configUrl = useRuntimeConfig().telegramUrl
  if (!instance.base_url || !configUrl) return true
  return sameEvolutionServer(instance.base_url, configUrl)
}

/**
 * The bridge's global key, for creating and deleting a session — and only ever
 * paired with the URL it belongs to.
 *
 * A row that carries its own admin key is a bring-your-own bridge, and both
 * halves come from it. A row naming a different bridge with no key of its own
 * answers undefined rather than being completed from our configuration: sending
 * our admin key to a bridge a user chose would hand them every session on ours.
 */
export function telegramAdminCredentials(
  server?: Pick<AppInstance, 'base_url' | 'admin_key'>,
): TelegramAdminCredentials | undefined {
  if (server?.admin_key) {
    if (!server.base_url) return undefined
    return { baseUrl: server.base_url, adminKey: server.admin_key, userSupplied: true }
  }
  if (server && !onDeploymentBridge(server)) return undefined

  const config = useRuntimeConfig()
  if (!config.telegramUrl || !config.telegramAdminKey) return undefined
  return { baseUrl: config.telegramUrl, adminKey: config.telegramAdminKey, userSupplied: false }
}

/**
 * Credentials for one Telegram connection.
 *
 * There is deliberately NO fallback to the bridge's admin key, and `admin_key`
 * is not in the picked type at all: that key creates and deletes every session
 * on its bridge, and a token holder must never be one missing field away from
 * it. A row without its session key or session id answers undefined, and the
 * caller refuses.
 */
export function telegramCredentialsForInstance(
  instance: Pick<AppInstance, 'base_url' | 'api_key' | 'instance_id'>,
): TelegramCredentials | undefined {
  const configUrl = useRuntimeConfig().telegramUrl
  const baseUrl = instance.base_url || configUrl
  if (!baseUrl || !instance.api_key || !instance.instance_id) return undefined
  return {
    baseUrl,
    apiKey: instance.api_key,
    sessionId: instance.instance_id,
    userSupplied: !sameEvolutionServer(baseUrl, configUrl),
  }
}

// Type aliases rather than interfaces throughout: a tool or route may return
// these, and an interface has no implicit index signature.

/** The bridge's `GET /sessions/:id/state`, as far as this app reads it. */
export type BridgeSessionState = {
  state: ConnectionState
  sessionLost: boolean
  revoked: boolean
  pairing?: 'qr' | 'password'
  passwordHint?: string
  passwordRejected?: boolean
  heldElsewhere: boolean
  me?: { id: string, username?: string, name?: string, phone?: string }
  lastError?: string
  stats: { chats: number, messages: number }
  /**
   * `backfillDays` is how far back the session's backfill reaches. Absent from a
   * bridge older than per-session caps, which is how `startTelegramPairing`
   * tells that a cap it needs would be ignored.
   */
  sync: { backfilling: boolean, pausedUntil?: string, dialogsSyncedAt?: string, pendingBackfill: number, backfillDays?: number }
}

export type BridgeQr = {
  state: BridgeSessionState
  qr?: { url: string, dataUrl: string, expiresAt: string }
}

export type BridgeResolved = {
  chatId: string
  type: string
  title: string | null
  username: string | null
  known: boolean
}

export type BridgeSent = {
  chatId: string
  messageId: number
  date: string
}

const BRIDGE_REQUEST_DEADLINE_MS = 20_000

/**
 * A `$fetch` bound to one bridge and one bearer key. Same check-not-pin caveat
 * as `createEvolutionClient`: `$fetch` resolves DNS itself, so the guard narrows
 * the rebinding window rather than closing it.
 */
function bridgeFetch(baseUrl: string, key: string, userSupplied: boolean) {
  return $fetch.create({
    baseURL: baseUrl,
    headers: { authorization: `Bearer ${key}` },
    retry: 0,
    async onRequest({ options }) {
      // Request and body, not headers alone: ofetch's `timeout` stops at the
      // headers, so a bridge trickling its body would hold the caller for ever
      // (GHSA-g2cf-mx92-xc53). See deadline.ts.
      applyRequestDeadline(options, BRIDGE_REQUEST_DEADLINE_MS)
      if (!userSupplied) return
      await assertPublicUrl(baseUrl, 'Telegram bridge URL')
      options.redirect = 'error'
    },
  })
}

export function createTelegramBridge(creds: TelegramCredentials) {
  const client = bridgeFetch(creds.baseUrl, creds.apiKey, creds.userSupplied)
  const session = `/sessions/${encodeURIComponent(creds.sessionId)}`

  return {
    state: () => client<BridgeSessionState>(`${session}/state`),
    // `backfillDays` caps how far back this session's history is fetched; null
    // leaves the bridge's own setting. Stored by the bridge at every call.
    pair: (backfillDays: number | null) => client<BridgeSessionState>(`${session}/pair`, { method: 'POST', body: { backfillDays } }),
    qr: () => client<BridgeQr>(`${session}/qr`),
    // The password is in the body of this one request and nowhere else: not
    // logged here, and the bridge never stores it.
    password: (password: string) => client<BridgeSessionState>(`${session}/password`, { method: 'POST', body: { password } }),
    reconnect: () => client<BridgeSessionState>(`${session}/reconnect`, { method: 'POST' }),
    logout: () => client<BridgeSessionState>(`${session}/logout`, { method: 'POST' }),
    resolve: (query: string) => client<BridgeResolved>(`${session}/resolve`, { method: 'POST', body: { query } }),
    send: (chatId: string, text: string) => client<BridgeSent>(`${session}/send`, { method: 'POST', body: { chatId, text } }),
    webhook: (url: string, headers: Record<string, string>) => client(`${session}/webhook`, { method: 'PUT', body: { url, headers } }),
  }
}

export type TelegramBridge = ReturnType<typeof createTelegramBridge>

/** For management routes, where the instance was read from the app database. */
export function telegramBridgeForInstance(instance: AppInstance): TelegramBridge {
  const creds = telegramCredentialsForInstance(instance)
  if (!creds) {
    throw createError({ statusCode: 409, statusMessage: 'This Telegram connection is not fully provisioned' })
  }
  return createTelegramBridge(creds)
}

export function createTelegramAdminBridge(creds: TelegramAdminCredentials) {
  const client = bridgeFetch(creds.baseUrl, creds.adminKey, creds.userSupplied)
  return {
    createSession: (name: string) => client<{ id: string, name: string, apiKey: string }>('/sessions', { method: 'POST', body: { name } }),
    deleteSession: (id: string) => client(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  }
}

/**
 * For MCP tool handlers. Reads `event.context.mcpAuth` and nothing else, like
 * `useEvolutionClient()`, and fails closed on anything that is not a Telegram
 * connection.
 */
export function useTelegramBridge(): TelegramBridge {
  const event = useEvent()
  const auth = event.context.mcpAuth as McpAuth | undefined
  if (!auth || auth.kind !== 'telegram') {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return createTelegramBridge(auth.telegram)
}

/**
 * The bridge's refusal when it runs without Telegram's API credentials — the
 * one `code` in its error bodies, and the contract with `http-error.ts` there.
 *
 * Keyed on the code rather than the 503 it rides on: the status alone reads as
 * an outage, and this is a setting someone has to make.
 */
const TELEGRAM_NOT_CONFIGURED = 'telegram_not_configured'

export function isTelegramNotConfigured(error: unknown): boolean {
  return (error as { data?: { code?: unknown } } | undefined)?.data?.code === TELEGRAM_NOT_CONFIGURED
}

/** Written for whoever can act on it, which is whoever runs the bridge. */
export function telegramNotConfiguredMessage(action?: string): string {
  return `${action ? `Could not ${action}: ` : ''}Telegram is not set up on this deployment yet. `
    + 'Create an app at my.telegram.org (API development tools), set TELEGRAM_API_ID and '
    + 'TELEGRAM_API_HASH on the Telegram bridge service and redeploy it.'
}

/**
 * Whether this deployment's own bridge can serve Telegram, for the create page
 * to say so before anyone clicks.
 *
 * `absent` means no default bridge is configured at all; `unconfigured` means it
 * runs without API credentials. Only ever asks `NUXT_TELEGRAM_URL` — a bridge a
 * user supplied is probed when they create on it, not from here — and only its
 * public `/health`, so no key is sent. A bridge from before credentials became
 * optional answers `{ ok: true }` with no `telegram` field; it could not have
 * started without them, so that reads as ready.
 */
export type BridgeReadiness = 'absent' | 'ready' | 'unconfigured' | 'unreachable'

export async function deploymentBridgeReadiness(): Promise<BridgeReadiness> {
  const creds = telegramAdminCredentials()
  if (!creds) return 'absent'
  try {
    // A signal, not `timeout`, so the body is covered too — see deadline.ts.
    const health = await $fetch<{ telegram?: unknown }>('/health', { baseURL: creds.baseUrl, retry: 0, signal: AbortSignal.timeout(5_000) })
    return health?.telegram === 'unconfigured' ? 'unconfigured' : 'ready'
  }
  catch (error) {
    console.error(`[telegram] the deployment bridge did not answer /health: ${httpStatusOf(error) ?? (error as Error | undefined)?.message}`)
    return 'unreachable'
  }
}

/**
 * Turn a failed bridge call into an answer a caller can act on.
 *
 * The bridge's 4xx bodies are written for callers — "not connected", "send to
 * -100… instead", Telegram's own refusal code — so those pass through with their
 * status. Anything else, including a 401 that means this row's session key is
 * wrong, is this deployment's problem: logged, because a handled error is
 * invisible to Nitro, and answered as 503. Our own refusals thrown inside the
 * same `try` (a half-provisioned row, an app-database outage) are already shaped
 * for the browser and pass through unchanged.
 */
export function relayBridgeError(error: unknown, action: string): never {
  if (isError(error)) throw error
  const status = httpStatusOf(error)
  if (isTelegramNotConfigured(error)) {
    console.error(`[telegram] could not ${action}: the bridge has no TELEGRAM_API_ID / TELEGRAM_API_HASH`)
    throw createError({ statusCode: 503, message: telegramNotConfiguredMessage(action) })
  }
  const message = (error as { data?: { error?: unknown } } | undefined)?.data?.error
  if (status !== undefined && [400, 404, 409, 422, 429].includes(status) && typeof message === 'string') {
    throw createError({ statusCode: status, message })
  }
  console.error(`[telegram] could not ${action}: bridge answered ${status ?? (error as Error | undefined)?.message ?? 'nothing'}`)
  throw createError({
    statusCode: 503,
    message: `Could not ${action}: the Telegram bridge for this connection did not answer.`,
  })
}

export type TelegramStatus = {
  /** The bridge's live client state, never a stored column. */
  state: ConnectionState
  /** Linked, and the connection to Telegram dropped. Reconnect; no scan. */
  sessionLost?: boolean
  /** Telegram ended the session (Telegram → Devices, or the account). Link again by QR. */
  revoked?: boolean
  pairing?: 'qr' | 'password'
  /** Another bridge process holds this session, so this one cannot say how it is. */
  heldElsewhere?: boolean
  telegramUserId?: string
  profileName?: string
  username?: string
  number?: string
  error?: string
  stats: { messages: number, chats: number }
  /** `historyDays`: how far back this account's history is fetched, in days. Absent from an older bridge. */
  sync?: { backfilling: boolean, pendingBackfill: number, dialogsSyncedAt?: string, pausedUntil?: string, historyDays?: number }
}

/**
 * A Telegram connection's state, from its bridge. Never throws: a bridge that
 * cannot be asked is `unknown` — not `close`, which reads as "not linked" and is
 * the wrong instruction — so the listing and the dashboard always render.
 */
export async function getTelegramStatus(instance: AppInstance): Promise<TelegramStatus> {
  const empty = { messages: 0, chats: 0 }
  const creds = telegramCredentialsForInstance(instance)
  if (!creds) {
    return { state: 'unknown', error: 'This Telegram connection is not fully provisioned.', stats: empty }
  }

  let bridge: BridgeSessionState
  try {
    bridge = await createTelegramBridge(creds).state()
  }
  catch (error) {
    console.error(`[telegram] could not read connection ${instance.id} from its bridge: ${httpStatusOf(error) ?? (error as Error | undefined)?.message}`)
    return { state: 'unknown', error: 'Could not reach the Telegram bridge for this connection.', stats: empty }
  }

  return {
    state: bridge.state,
    ...(bridge.sessionLost && { sessionLost: true }),
    ...(bridge.revoked && { revoked: true }),
    ...(bridge.pairing && { pairing: bridge.pairing }),
    ...(bridge.heldElsewhere && { heldElsewhere: true }),
    ...(bridge.me && {
      telegramUserId: bridge.me.id,
      profileName: bridge.me.name,
      username: bridge.me.username,
      number: bridge.me.phone,
    }),
    ...(bridge.lastError && { error: bridge.lastError }),
    stats: { messages: bridge.stats.messages, chats: bridge.stats.chats },
    sync: {
      backfilling: bridge.sync.backfilling,
      pendingBackfill: bridge.sync.pendingBackfill,
      ...(bridge.sync.dialogsSyncedAt && { dialogsSyncedAt: bridge.sync.dialogsSyncedAt }),
      ...(bridge.sync.pausedUntil && { pausedUntil: bridge.sync.pausedUntil }),
      ...(typeof bridge.sync.backfillDays === 'number' && { historyDays: bridge.sync.backfillDays }),
    },
  }
}

/**
 * What the pairing screen needs from the bridge, and nothing else.
 *
 * The QR's image is passed on and its `tg://login` URL is not: the page renders
 * the image, and the URL is exactly as much of a login credential as the image
 * is, so it has no reason to travel further than it must.
 */
export type TelegramPairingView = {
  state: ConnectionState
  pairing?: 'qr' | 'password'
  passwordHint?: string
  passwordRejected?: boolean
  sessionLost?: boolean
  revoked?: boolean
  error?: string
  qr?: { dataUrl: string, expiresAt: string }
}

export function pairingView(bridge: BridgeSessionState, qr?: BridgeQr['qr']): TelegramPairingView {
  return {
    state: bridge.state,
    ...(bridge.pairing && { pairing: bridge.pairing }),
    ...(bridge.passwordHint && { passwordHint: bridge.passwordHint }),
    ...(bridge.passwordRejected && { passwordRejected: true }),
    ...(bridge.sessionLost && { sessionLost: true }),
    ...(bridge.revoked && { revoked: true }),
    ...(bridge.lastError && { error: bridge.lastError }),
    ...(qr && { qr: { dataUrl: qr.dataUrl, expiresAt: qr.expiresAt } }),
  }
}
