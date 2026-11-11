import type { AppInstance } from './app-db'
import type { Actor } from './org'
import type { BridgeSessionState } from './telegram'
import { TELEGRAM_RECENT_HISTORY_DAYS } from '#shared/history'

/**
 * Telegram connection lifecycle: the only callers of the bridge's admin key, so
 * its blast radius is this file — as `instances.ts` is for Evolution's.
 */

export interface TelegramProvisionInput {
  label?: string
  /**
   * A bridge the user runs. All or nothing: half of it is never completed from
   * this deployment's configuration — see `telegramAdminCredentials`.
   */
  server?: { baseUrl: string, adminKey: string, dbUrl?: string }
}

/**
 * Start linking by QR, with the history cap this connection's plan calls for.
 *
 * Fails closed: a limited connection is never paired by a bridge that cannot
 * apply the cap. A bridge older than per-session caps ignores the request body
 * and reports no `backfillDays`, so it is asked first — after `pair`, the flow
 * would already be running uncapped — and refused with 503 and a log line
 * naming the fix. Unlimited connections pair on any bridge.
 */
export async function startTelegramPairing(instance: AppInstance): Promise<BridgeSessionState> {
  const bridge = telegramBridgeForInstance(instance)
  // A limited connection fetches only the last `TELEGRAM_RECENT_HISTORY_DAYS`
  // (`historyLimited`). Decided here, when the bridge stores the cap: upgrading
  // or lapsing changes nothing for an account already linked until it is
  // linked again, as with WhatsApp.
  if (!(await historyLimited(instance))) return await bridge.pair(null)

  const before = await bridge.state()
  if (typeof before.sync?.backfillDays !== 'number') {
    console.error(`[telegram] not pairing connection ${instance.id}: its organization fetches ${TELEGRAM_RECENT_HISTORY_DAYS} days of history, and the deployment's Telegram bridge is too old to cap a session's history. Update the bridge to the same release as the app.`)
    throw createError({ statusCode: 503, statusMessage: 'Linking Telegram accounts is briefly unavailable. Try again in a few minutes.' })
  }
  return await bridge.pair(TELEGRAM_RECENT_HISTORY_DAYS)
}

/**
 * Create a session on the bridge, then the row that points at it.
 *
 * Nothing is linked yet: pairing is a separate, explicit step on the dashboard,
 * because it binds a real Telegram account and a page refresh must never start
 * one. If the row cannot be written the session is deleted again, so a failed
 * create leaves nothing behind on the bridge.
 */
export async function provisionTelegramInstance(actor: Actor, input: TelegramProvisionInput = {}): Promise<AppInstance> {
  const { label, server } = input

  if (server) {
    assertOwnServersAllowed('Telegram bridge', actor.org.id)
    await assertPublicUrl(server.baseUrl, 'Telegram bridge URL')
  }
  // Proved before anything is created. `requireTable` is what separates the
  // wrong database from an account with no chats, which otherwise look alike.
  if (server?.dbUrl) await probePgConnection(server.dbUrl, { requireTable: 'telegram.messages' })

  const creds = telegramAdminCredentials(server ? { base_url: server.baseUrl, admin_key: server.adminKey } : undefined)
  if (!creds) {
    throw createError({
      statusCode: 422,
      statusMessage: 'No Telegram bridge is available. Set NUXT_TELEGRAM_URL and NUXT_TELEGRAM_ADMIN_KEY '
        + 'to provide a default' + (ownServersAllowed() ? ', or supply your own bridge URL and admin key.' : '.'),
    })
  }

  const admin = createTelegramAdminBridge(creds)
  const name = generateInstanceName()

  let session: { id: string, apiKey: string }
  try {
    session = await admin.createSession(name)
  }
  catch (error) {
    const status = httpStatusOf(error)
    console.error(`[telegram] could not create a session on ${creds.userSupplied ? 'a user-supplied' : 'the deployment'} bridge: ${status ?? (error as Error | undefined)?.message}`)
    if (status === 401) {
      throw createError({ statusCode: 422, statusMessage: 'The Telegram bridge refused the admin key.' })
    }
    if (isTelegramNotConfigured(error)) {
      throw createError({
        statusCode: 422,
        statusMessage: creds.userSupplied
          ? 'Telegram is not set up on your bridge: set TELEGRAM_API_ID and TELEGRAM_API_HASH on it and restart it.'
          : telegramNotConfiguredMessage(),
      })
    }
    throw createError({ statusCode: 502, statusMessage: 'Could not reach the Telegram bridge to create the connection.' })
  }

  let record: AppInstance
  try {
    record = await insertRow<AppInstance>('instances', {
      org: actor.org.id,
      created_by: actor.user.id,
      kind: 'telegram',
      name,
      instance_id: session.id,
      api_key: session.apiKey,
      // The URL actually used, never runtimeConfig, for the reason
      // provisionWhatsappInstance gives.
      base_url: creds.baseUrl,
      admin_key: server ? server.adminKey : '',
      telegram_db_url: server?.dbUrl ?? '',
      label: label?.trim() || 'Telegram account',
    })
  }
  catch (error) {
    await admin.deleteSession(session.id).catch(() => {})
    throw error
  }

  // Outside the block above, as in provisionWhatsappInstance: a missing alert
  // subscription is not worth tearing down a working connection, and the hourly
  // sweep re-asserts it.
  await registerTelegramWebhook(record).catch((error) => {
    console.error(`[telegram] could not register the webhook for ${record.id} (${record.name}): ${httpStatusOf(error) ?? (error as Error | undefined)?.message}`)
  })

  return record
}

let webhookUrlWarned = false

/**
 * Where this deployment's bridge deliveries should land: `NUXT_TELEGRAM_WEBHOOK_URL`
 * when set, else the public app URL. The override exists for development, where
 * a bridge in a container cannot reach `localhost` on the host.
 */
function telegramWebhookUrl(): string | undefined {
  const config = useRuntimeConfig()
  if (config.telegramWebhookUrl) return config.telegramWebhookUrl
  const appUrl = config.public.appUrl
  return appUrl ? `${appUrl.replace(/\/+$/, '')}/api/webhook/telegram` : undefined
}

/**
 * Subscribe this connection's bridge session to its state changes.
 *
 * The bridge's counterpart to `registerConnectionWebhook`, with the same
 * contract: idempotent, called at provision time and again on every sweep, and
 * made with the session's own key. The bridge seals the headers at rest and
 * re-sends the current state only when the URL changes, so the hourly call is
 * quiet.
 *
 * The secret goes to a bring-your-own bridge as well, exactly as it goes to a
 * bring-your-own Evolution server. That is survivable for the same reason: the
 * route treats every delivery as a hint and reads the live state before acting.
 */
export async function registerTelegramWebhook(instance: AppInstance): Promise<void> {
  const url = telegramWebhookUrl()
  if (!url) {
    if (!webhookUrlWarned) {
      webhookUrlWarned = true
      console.warn(
        '[telegram] neither NUXT_TELEGRAM_WEBHOOK_URL nor NUXT_PUBLIC_APP_URL is set, so Telegram '
        + 'connections are not subscribed to bridge events. Disconnect alerts still work, '
        + 'but only as fast as the five-minute sweep.',
      )
    }
    return
  }

  const creds = telegramCredentialsForInstance(instance)
  if (!creds) return

  const { webhookSecret } = useRuntimeConfig()
  await createTelegramBridge(creds).webhook(url, webhookSecret ? { 'x-webhook-secret': webhookSecret } : {})
}

/**
 * Release what a Telegram connection holds: its reader pool, and its session on
 * the bridge — which logs the account out on Telegram's side and deletes every
 * chat synced for it.
 *
 * Throws when the bridge cannot be reached, so the row survives and still points
 * at a live session — the ordering `deleteInstance` insists on. A missing admin
 * key is not a reason to refuse, for the reason given there: a connection nobody
 * can delete is worse than a logged orphan.
 */
export async function deleteTelegramSession(instance: AppInstance): Promise<void> {
  await closeKeyedPool(`tg:${instance.id}`)

  const creds = telegramAdminCredentials(instance)
  if (!creds || !instance.instance_id) {
    console.error(
      `[telegram] deleting ${instance.id} (${instance.name}) without removing its bridge session: `
      + 'no admin key is available for its bridge. The session may need removing there by hand.',
    )
    return
  }

  try {
    await createTelegramAdminBridge(creds).deleteSession(instance.instance_id)
  }
  catch (error) {
    // Already gone on the bridge; carry on and remove the row.
    if (httpStatusOf(error) !== 404) throw error
  }
}
