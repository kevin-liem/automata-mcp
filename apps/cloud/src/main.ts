import { Billing } from './billing.ts'
import { type CloudConfig, loadConfig } from './config.ts'
import { ConsentRegions } from './consent-region.ts'
import { Crm } from './crm.ts'
import { connect, ensureCloudSchema, waitForApp } from './db.ts'
import { createCloudServer } from './http.ts'
import { describeError } from './http-error.ts'
import { consumeBillingEvents, consumeCrmEvents } from './outbox.ts'
import { applyPlanEntitlements, recordPlanChanges, writeEntitlementDefaults } from './plans.ts'

/**
 * The hosted offering's service: everything the hosted deployment does that a
 * self-hosted one never should: plans and Stripe, and the Brevo CRM sync, both
 * fed by the web app's event outbox. PostHog telemetry joins them later.
 *
 * The web app enforces limits from its own database and knows no plan; this
 * service writes those limits. It never serves a browser — the web app calls
 * it with an admin key — and Stripe calls its webhook.
 */

const OUTBOX_INTERVAL_MS = 15_000
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000

// Defence in depth: every request path catches its own rejections; one that
// slips through is logged and the process keeps serving. Exiting would stop
// the Stripe webhook, the outbox consumers and the Billing page for one failed
// operation, and every write here is idempotent and re-driven by reconcile.
// Failures that must restart the process (startWork) exit explicitly; thrown
// (uncaught) exceptions stay fatal.
process.on('unhandledRejection', (error) => {
  console.error(`[cloud] unhandled rejection: ${describeError(error)}`)
})

let config: CloudConfig
try {
  config = loadConfig()
}
catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}

const sql = connect(config.databaseUrl)

try {
  await ensureCloudSchema(sql)
}
catch (error) {
  console.error(`cloud cannot start: could not prepare schema "cloud": ${describeError(error)}`)
  await sql.end({ timeout: 5 })
  process.exit(1)
}

const billing = new Billing(sql, config.stripe, config.appUrl)
const crm = new Crm(sql, config.brevo)
const state = { appReady: false, stopped: false }
const regions = new ConsentRegions(config.ipLookupUrl)
const server = createCloudServer(billing, crm, regions, config, state)

// :: accepts IPv6 and IPv4 (legacy Railway private networking is IPv6-only).
// A host with IPv6 disabled refuses :: outright, so fall back to IPv4 there.
await new Promise<void>((resolve, reject) => {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EAFNOSUPPORT') return reject(error)
    server.listen(config.port, '0.0.0.0', resolve)
  })
  server.listen(config.port, '::', resolve)
})
console.info(`[cloud] listening on :${config.port}`)
if (!billing.configured) {
  console.warn('[cloud] STRIPE_SECRET_KEY is not set — running without billing. Plan limits are still written; starting Pro answers 503.')
  if (config.ignoredStripeVars.length > 0) {
    console.warn(`[cloud] ignoring ${config.ignoredStripeVars.join(', ')}: they do nothing without STRIPE_SECRET_KEY.`)
  }
}
if (!crm.configured) {
  console.info('[cloud] BREVO_API_KEY is not set — running without the CRM sync.')
  if (config.ignoredBrevoVars.length > 0) {
    console.warn(`[cloud] ignoring ${config.ignoredBrevoVars.join(', ')}: they do nothing without BREVO_API_KEY.`)
  }
}

const timers: NodeJS.Timeout[] = []

/**
 * Once the web app's schema is there: publish Free's limits for new
 * organizations, bring every organization's limits into line with its stored
 * plan, then start the outbox consumers and the reconcile.
 */
async function startWork(): Promise<void> {
  await waitForApp(sql, state)
  if (state.stopped) return

  await writeEntitlementDefaults(sql)
  await sql.begin(async (tx) => {
    const changes = await applyPlanEntitlements(tx)
    await recordPlanChanges(tx, changes)
    if (changes.length) console.info(`[cloud] set plan limits on ${changes.length} organization(s)`)
  })
  state.appReady = true
  console.info('[cloud] ready')

  /** Run `pass` every interval, skipping a tick while the previous pass is still going. */
  const everyOutboxTick = (label: string, pass: () => Promise<unknown>) => {
    let running = false
    timers.push(setInterval(() => {
      if (running) return
      running = true
      pass()
        .catch(error => console.error(`[${label}] pass failed: ${describeError(error)}`))
        .finally(() => { running = false })
    }, OUTBOX_INTERVAL_MS))
  }

  everyOutboxTick('outbox', () => consumeBillingEvents(sql, billing))
  // A separate guard and cursor: a slow or paused Brevo never holds up seats
  // and cancellations, and the reverse.
  if (crm.configured) everyOutboxTick('crm', () => consumeCrmEvents(sql, crm))

  // The backstop for a lost webhook and a seat sync that failed: re-read every
  // billed organization. Idempotent, so several replicas may run it.
  const reconcile = async () => {
    if (!billing.configured) return
    let synced = 0
    let failed = 0
    for (const orgId of await billing.billedOrgIds()) {
      try {
        await billing.syncOrg(orgId)
        await billing.syncSeats(orgId)
        synced++
      }
      catch (error) {
        failed++
        console.error(`[reconcile] organization ${orgId} failed: ${describeError(error)}`)
      }
    }
    if (synced || failed) console.info(`[reconcile] ${synced} organization(s) synced, ${failed} failed`)
  }
  timers.push(setInterval(() => { reconcile().catch(error => console.error(`[reconcile] failed: ${describeError(error)}`)) }, RECONCILE_INTERVAL_MS))
}

startWork().catch((error) => {
  // Without the defaults row the web app refuses signups, so this must not be
  // a silent failure; exiting lets the platform restart and retry.
  console.error(`[cloud] could not start work: ${describeError(error)}`)
  process.exit(1)
})

async function stop(signal: string): Promise<void> {
  if (state.stopped) return
  state.stopped = true
  console.info(`[cloud] ${signal}: stopping`)
  for (const timer of timers) clearInterval(timer)
  server.close()
  await sql.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGTERM', () => { void stop('SIGTERM') })
process.on('SIGINT', () => { void stop('SIGINT') })
