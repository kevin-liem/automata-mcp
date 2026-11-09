import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { Billing } from './billing.ts'
import type { CloudConfig } from './config.ts'
import type { ConsentRegions } from './consent-region.ts'
import type { Crm } from './crm.ts'
import { HttpError, describeError } from './http-error.ts'

/**
 * The cloud service's HTTP API.
 *
 *   public   GET /health, POST /webhooks/stripe (Stripe-signed)
 *   admin    everything under /orgs/:id — called by the web app only, with
 *            CLOUD_ADMIN_KEY as a bearer. The web app has already decided the
 *            caller is an admin of that organization; this service trusts that
 *            decision and never sees a browser session.
 *            POST /consent-region — the signup page's visitor, by the address
 *            the web app took from the request; no session involved.
 *
 * Request bodies and URLs are never logged; errors are logged against the
 * route's label. Messages in 4xx answers are written for the person in the
 * browser — the web app relays them as they are.
 */

const MAX_BODY_BYTES = 16 * 1024
const MAX_WEBHOOK_BYTES = 512 * 1024

type Access = 'public' | 'admin'

interface Reply {
  status: number
  body?: unknown
}

interface Route {
  label: string
  method: string
  pattern: RegExp
  access: Access
  /** The body as bytes, not JSON — the Stripe signature covers the raw payload. */
  raw?: boolean
  /** Refused with 503 until the web app's schema is ready. */
  needsApp?: boolean
  handle: (request: { id: string, body: unknown, raw?: Buffer, headers: IncomingMessage['headers'] }) => Promise<Reply>
}

const checkoutBody = z.object({ email: z.string().email().max(320) })
const consentRegionBody = z.object({ ip: z.string().max(64) })

/** Webhook events that can change an organization's subscription. */
const STRIPE_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
])

export function createCloudServer(billing: Billing, crm: Crm, regions: ConsentRegions, config: CloudConfig, state: { appReady: boolean }): Server {
  const adminDigest = sha256(config.adminKey)

  const routes: Route[] = [
    {
      label: 'GET /health', method: 'GET', pattern: /^\/health$/, access: 'public',
      handle: async () => ({
        status: 200,
        body: {
          ok: true,
          app: state.appReady ? 'ready' : 'waiting',
          billing: billing.configured ? 'configured' : 'unconfigured',
          crm: crm.status,
        },
      }),
    },
    {
      // The payload is a hint: only the customer id is read, and the
      // subscription is re-read from Stripe. Stripe retries any non-2xx, so a
      // sync that fails answers 500 to be delivered again.
      label: 'POST /webhooks/stripe', method: 'POST', pattern: /^\/webhooks\/stripe$/, access: 'public', raw: true, needsApp: true,
      handle: async ({ raw, headers }) => {
        const signature = headers['stripe-signature']
        if (!billing.configured) return { status: 404, body: { error: 'Not found.' } }
        if (typeof signature !== 'string' || !raw?.length) {
          console.warn('[webhook] Stripe delivery without a signature or body refused')
          throw new HttpError(400, 'Missing signature.')
        }

        let event
        try {
          event = billing.constructEvent(raw, signature)
        }
        catch (error) {
          console.warn(`[webhook] Stripe delivery with a bad signature refused: ${describeError(error)}`)
          throw new HttpError(400, 'Invalid signature.')
        }
        if (!STRIPE_EVENTS.has(event.type)) return { status: 200, body: { received: true } }

        const object = event.data.object as { customer?: string | { id: string } | null }
        const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id
        if (!customerId) return { status: 200, body: { received: true } }

        const orgId = await billing.orgIdForCustomer(customerId)
        if (!orgId) {
          // Another deployment's customer on a shared Stripe account, or an
          // organization deleted since. Nothing to retry.
          console.warn(`[webhook] Stripe ${event.type} for unknown customer ${customerId} ignored`)
          return { status: 200, body: { received: true } }
        }

        await billing.syncOrg(orgId)
        await billing.syncSeats(orgId)
        return { status: 200, body: { received: true } }
      },
    },
    {
      // Never fails for want of an answer: `unknown` is an answer, and the web
      // app falls back to the browser's time zone on it.
      label: 'POST /consent-region', method: 'POST', pattern: /^\/consent-region$/, access: 'admin',
      handle: async ({ body }) => ({ status: 200, body: { region: await regions.regionFor(parse(consentRegionBody, body).ip) } }),
    },
    {
      label: 'GET /orgs/:id/billing', method: 'GET', pattern: /^\/orgs\/([^/]+)\/billing$/, access: 'admin', needsApp: true,
      handle: async ({ id }) => ({ status: 200, body: await billing.summary(id) }),
    },
    {
      label: 'POST /orgs/:id/checkout', method: 'POST', pattern: /^\/orgs\/([^/]+)\/checkout$/, access: 'admin', needsApp: true,
      handle: async ({ id, body }) => ({ status: 200, body: { url: await billing.checkout(id, parse(checkoutBody, body).email) } }),
    },
    {
      label: 'POST /orgs/:id/portal', method: 'POST', pattern: /^\/orgs\/([^/]+)\/portal$/, access: 'admin', needsApp: true,
      handle: async ({ id }) => ({ status: 200, body: { url: await billing.portal(id) } }),
    },
    {
      label: 'POST /orgs/:id/sync', method: 'POST', pattern: /^\/orgs\/([^/]+)\/sync$/, access: 'admin', needsApp: true,
      handle: async ({ id }) => {
        await billing.syncOrg(id)
        await billing.syncSeats(id)
        return { status: 200, body: { ok: true } }
      },
    },
  ]

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Node's parser accepts targets WHATWG URL refuses (`//x:99999/`), and this
    // runs before any route's try: parse it guarded, answer 400.
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://cloud')
    }
    catch {
      req.resume()
      return send(res, { status: 400, body: { error: 'Bad request target.' } })
    }
    const path = url.pathname
    const matching = routes.filter(route => route.pattern.test(path))
    const route = matching.find(candidate => candidate.method === req.method)

    if (!route) {
      req.resume()
      return send(res, matching.length > 0 ? { status: 405, body: { error: 'Method not allowed.' } } : { status: 404, body: { error: 'Not found.' } })
    }

    try {
      if (route.access === 'admin') {
        const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
        if (!bearer || !digestsEqual(sha256(bearer), adminDigest)) {
          req.resume()
          return send(res, { status: 401, body: { error: 'Unauthorized.' } })
        }
      }
      if (route.needsApp && !state.appReady) {
        req.resume()
        throw new HttpError(503, 'Billing is starting up. Try again in a moment.')
      }

      const id = decodeURIComponent(route.pattern.exec(path)?.[1] ?? '')
      const bytes = req.method === 'POST' ? await readBody(req, route.raw ? MAX_WEBHOOK_BYTES : MAX_BODY_BYTES) : undefined
      const body = bytes && !route.raw ? parseJson(bytes) : undefined
      send(res, await route.handle({ id, body, raw: route.raw ? bytes : undefined, headers: req.headers }))
    }
    catch (error) {
      if (error instanceof HttpError) {
        return send(res, { status: error.status, body: { error: error.message, ...(error.code && { code: error.code }) } })
      }
      console.error(`[http] ${route.label} failed: ${describeError(error)}`)
      send(res, { status: 500, body: { error: 'Internal error.' } })
    }
  }

  // Never `void`: a rejected handler is an unhandled rejection, which ends the
  // process for every other caller.
  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(`[http] request failed: ${describeError(error)}`)
      if (!res.headersSent) send(res, { status: 500, body: { error: 'Internal error.' } })
      else res.destroy()
    })
  })
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'Request body too large.')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function parseJson(bytes: Buffer): unknown {
  if (bytes.length === 0) return {}
  try {
    return JSON.parse(bytes.toString('utf8'))
  }
  catch {
    throw new HttpError(400, 'Request body is not valid JSON.')
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const detail = result.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
  throw new HttpError(400, detail)
}

function send(res: ServerResponse, reply: Reply): void {
  if (res.headersSent) return
  if (reply.body === undefined) {
    res.writeHead(reply.status, { 'cache-control': 'no-store' }).end()
    return
  }
  res.writeHead(reply.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(reply.body))
}
