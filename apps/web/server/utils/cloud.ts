/**
 * The hosted offering, as the web app sees it: one switch and one client.
 *
 * Everything that sells plans — Stripe, Checkout, the webhook, seat billing —
 * lives in the separate cloud service (`apps/cloud`). The web app knows none of
 * it. It enforces limits from its own columns (entitlements.ts), records
 * account changes in the outbox (hosted-events.ts), and forwards the Billing
 * page's requests here. A self-hosted deployment sets none of this and runs
 * with no plans, no limits and no events.
 *
 * **Hosted mode** is `NUXT_CLOUD_URL` set. `NUXT_BILLING`, which phase one of
 * this split used, is still read so a hosted deployment that upgrades without
 * setting the new variables fails closed — plans stay on, Billing answers 503
 * and the startup log says what to set — rather than quietly handing every new
 * organization unlimited use.
 */

let warnedLegacy = false

function cloudUrl(): string {
  return String(useRuntimeConfig().cloudUrl ?? '').trim().replace(/\/+$/, '')
}

function legacyBillingOn(): boolean {
  const value = String(useRuntimeConfig().billing ?? '').trim().toLowerCase()
  return Boolean(value) && value !== 'off'
}

export function hostedMode(): boolean {
  if (cloudUrl()) return true
  if (legacyBillingOn()) {
    if (!warnedLegacy) {
      warnedLegacy = true
      console.error(
        '[cloud] NUXT_BILLING is set but NUXT_CLOUD_URL is not. Billing moved to the cloud service: set '
        + 'NUXT_CLOUD_URL and NUXT_CLOUD_ADMIN_KEY. Plans stay enforced meanwhile; the Billing page answers 503.',
      )
    }
    return true
  }
  return false
}

/**
 * 404 for a hosted-only route on a deployment without the hosted offering, so
 * a self-hosted install exposes nothing that even suggests plans exist.
 */
export function requireHosted(): void {
  if (!hostedMode()) throw createError({ statusCode: 404, statusMessage: 'Not found' })
}

/**
 * Whether an organization may put a WhatsApp or Telegram connection on a server
 * it runs itself — its own Evolution server or Telegram bridge, and that
 * server's message database. Self-hosted only.
 *
 * On the hosted service every self-signup is an organization admin, so a
 * bring-your-own server is an address a stranger chose that this deployment
 * then dials on its own schedule: the alert sweep, the unpaired reaper and
 * webhook re-registration. That is GHSA-g2cf-mx92-xc53's whole surface, plus a
 * DNS-rebinding window `evolution.ts` documents and a message database with no
 * client-side query timeout — for a feature no hosted customer used. A
 * self-hosted deployment is single-tenant: there is no stranger to defend
 * against, and running your own server is the point.
 *
 * Stops new ones only. A row that already names its own server keeps working
 * (none existed on the hosted service when this was added); refusing it at
 * request time would read as an outage and mail everyone who uses it.
 *
 * The one rule. Check it wherever a request could create or point a
 * connection at a user's own server, before the address is resolved or
 * dialled. The create page hides the option on `/api/hosted`, but that is
 * presentation — this is the control.
 */
export function ownServersAllowed(): boolean {
  return !hostedMode()
}

/** 422 unless `ownServersAllowed()`. Logged, since Nitro does not log a handled refusal. */
export function assertOwnServersAllowed(what: 'Evolution server' | 'Telegram bridge', org: string): void {
  if (ownServersAllowed()) return
  console.warn(`[cloud] refused a bring-your-own ${what} for org ${org}: not available on the hosted service`)
  const message = `Your own ${what} isn't available on the hosted service. Use the one provided, `
    + 'or self-host DOPE to bring your own.'
  throw createError({ statusCode: 422, statusMessage: message, message })
}

/**
 * Call the cloud service as the web app, with its admin key.
 *
 * A 4xx from the service carries a message written for the person in the
 * browser (409 "already has a subscription", 503 "billing not available"), so
 * it is relayed as is. Anything else — the service down, a 5xx, a timeout — is
 * logged here, because a handled error is invisible to Nitro, and answered 503.
 */
export async function cloudFetch<T>(path: string, options: { method?: 'GET' | 'POST', body?: Record<string, unknown>, timeout?: number } = {}): Promise<T> {
  const base = cloudUrl()
  const key = String(useRuntimeConfig().cloudAdminKey ?? '').trim()
  if (!base || !key) {
    console.error('[cloud] NUXT_CLOUD_URL or NUXT_CLOUD_ADMIN_KEY is not set; the Billing page cannot reach the cloud service.')
    throw createError({ statusCode: 503, statusMessage: 'Billing is not available right now.' })
  }

  try {
    return await $fetch<T>(`${base}${path}`, {
      method: options.method ?? 'GET',
      body: options.body,
      headers: { authorization: `Bearer ${key}` },
      timeout: options.timeout ?? 15_000,
      retry: 0,
    })
  }
  catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status
    const data = (error as { data?: { error?: unknown } }).data
    if (status && status >= 400 && status < 500 && typeof data?.error === 'string') {
      throw createError({ statusCode: status, statusMessage: data.error })
    }
    if (status === 503 && typeof data?.error === 'string') {
      throw createError({ statusCode: 503, statusMessage: data.error })
    }
    console.error(`[cloud] ${options.method ?? 'GET'} ${path.replace(/\/orgs\/[^/]+/, '/orgs/:id')} failed:`, (error as Error)?.message ?? error)
    throw createError({ statusCode: 503, statusMessage: 'Billing is not available right now. Try again in a moment.' })
  }
}
