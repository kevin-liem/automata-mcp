import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { BridgeConfig } from './config.ts'
import { digestsEqual, hashKey } from './crypto.ts'
import { HttpError, describeError, telegramNotConfigured } from './http-error.ts'
import type { SessionManager } from './sessions.ts'

/**
 * The bridge's HTTP API, shaped like Evolution's: one global admin key creates
 * and deletes sessions, and each session has its own key for everything else.
 *
 * The admin key does **not** open session routes. A deployment's app holds both,
 * but a key that can create sessions has no reason to also read one, and keeping
 * them apart is what lets the per-session key be the only thing a leaked
 * connection record exposes.
 *
 * Request bodies are never logged — one is a two-step verification password,
 * another is a message — and neither is the raw URL: errors are logged against
 * the route's label.
 */

const MAX_BODY_BYTES = 16 * 1024

type Access = 'public' | 'admin' | 'session'

interface Reply {
  status: number
  body?: unknown
}

interface Route {
  label: string
  method: string
  pattern: RegExp
  access: Access
  /**
   * Talks to Telegram, so it is refused with `telegramNotConfigured()` when the
   * bridge runs without API credentials. Checked after authentication, so an
   * unauthenticated caller learns nothing about the configuration from it.
   */
  needsTelegram?: boolean
  handle: (request: { id: string, body: unknown, query: URLSearchParams }) => Promise<Reply>
}

const createBody = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, _ and - only'),
})

// Optional so a caller that sends no body (an older app) pairs with the
// deployment's own backfill setting.
const pairBody = z.object({ backfillDays: z.number().int().min(0).max(36_500).nullable().default(null) })

const passwordBody = z.object({ password: z.string().min(1).max(256) })

const webhookBody = z.object({
  url: z.string().url().refine(url => /^https?:\/\//i.test(url), 'must be http or https').nullable(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(512))
    .refine(headers => Object.keys(headers).length <= 10, 'at most 10 headers')
    .default({}),
})

const resolveBody = z.object({ query: z.string().trim().min(1).max(256) })

const sendBody = z.object({
  // A marked chat id as a string: a JS number would round a 64-bit id into a different chat.
  chatId: z.string().regex(/^-?\d{1,20}$/, 'a chat id as a string of digits'),
  // Telegram's own limit for one text message.
  text: z.string().min(1).max(4096),
})

export function createBridgeServer(manager: SessionManager, config: BridgeConfig): Server {
  const adminDigest = hashKey(config.adminKey)

  const routes: Route[] = [
    {
      label: 'GET /health', method: 'GET', pattern: /^\/health$/, access: 'public',
      // Stays 200 without Telegram so a platform health check passes; `telegram`
      // is what the app reads to tell an admin what to set. No value is exposed.
      // `sync` is the live queues' backlog, as totals: an alarm on it catches a
      // session falling behind before the heap does (#188).
      handle: async () => ({
        status: 200,
        body: { ok: true, telegram: config.telegram ? 'configured' : 'unconfigured', sync: manager.load() },
      }),
    },
    {
      label: 'POST /sessions', method: 'POST', pattern: /^\/sessions$/, access: 'admin', needsTelegram: true,
      handle: async ({ body }) => ({ status: 201, body: await manager.create(parse(createBody, body).name) }),
    },
    {
      label: 'DELETE /sessions/:id', method: 'DELETE', pattern: /^\/sessions\/([^/]+)$/, access: 'admin',
      handle: async ({ id }) => {
        await manager.remove(id)
        return { status: 204 }
      },
    },
    {
      label: 'GET /sessions/:id/state', method: 'GET', pattern: /^\/sessions\/([^/]+)\/state$/, access: 'session',
      // Counts are cached per session for 30 s; `?fresh=counts` reads them now.
      handle: async ({ id, query }) => ({
        status: 200,
        body: await manager.state(id, { freshCounts: query.get('fresh') === 'counts' }),
      }),
    },
    {
      label: 'POST /sessions/:id/pair', method: 'POST', pattern: /^\/sessions\/([^/]+)\/pair$/, access: 'session', needsTelegram: true,
      handle: async ({ id, body }) => ({ status: 202, body: await manager.pair(id, parse(pairBody, body).backfillDays) }),
    },
    {
      label: 'GET /sessions/:id/qr', method: 'GET', pattern: /^\/sessions\/([^/]+)\/qr$/, access: 'session',
      handle: async ({ id }) => ({ status: 200, body: await manager.qr(id) }),
    },
    {
      label: 'POST /sessions/:id/password', method: 'POST', pattern: /^\/sessions\/([^/]+)\/password$/, access: 'session', needsTelegram: true,
      handle: async ({ id, body }) => ({ status: 202, body: await manager.submitPassword(id, parse(passwordBody, body).password) }),
    },
    {
      label: 'POST /sessions/:id/logout', method: 'POST', pattern: /^\/sessions\/([^/]+)\/logout$/, access: 'session',
      handle: async ({ id }) => ({ status: 200, body: await manager.logout(id) }),
    },
    {
      label: 'POST /sessions/:id/reconnect', method: 'POST', pattern: /^\/sessions\/([^/]+)\/reconnect$/, access: 'session', needsTelegram: true,
      handle: async ({ id }) => ({ status: 202, body: await manager.reconnect(id) }),
    },
    {
      label: 'PUT /sessions/:id/webhook', method: 'PUT', pattern: /^\/sessions\/([^/]+)\/webhook$/, access: 'session',
      handle: async ({ id, body }) => {
        const { url, headers } = parse(webhookBody, body)
        await manager.setWebhook(id, url, headers)
        return { status: 204 }
      },
    },
    {
      label: 'GET /sessions/:id/chats', method: 'GET', pattern: /^\/sessions\/([^/]+)\/chats$/, access: 'session',
      handle: async ({ id, query }) => ({
        status: 200,
        body: await manager.chats(id, clampInt(query.get('take'), 100, 1, 500), clampInt(query.get('skip'), 0, 0, 1_000_000)),
      }),
    },
    {
      label: 'POST /sessions/:id/resolve', method: 'POST', pattern: /^\/sessions\/([^/]+)\/resolve$/, access: 'session', needsTelegram: true,
      handle: async ({ id, body }) => ({ status: 200, body: await manager.resolve(id, parse(resolveBody, body).query) }),
    },
    {
      label: 'POST /sessions/:id/send', method: 'POST', pattern: /^\/sessions\/([^/]+)\/send$/, access: 'session', needsTelegram: true,
      handle: async ({ id, body }) => {
        const { chatId, text } = parse(sendBody, body)
        return { status: 200, body: await manager.send(id, chatId, text) }
      },
    },
  ]

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Node's parser accepts targets WHATWG URL refuses (`//x:99999/`), and this
    // runs before any route's try: parse it guarded, answer 400.
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://bridge')
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
      const id = route.pattern.exec(path)?.[1] ?? ''
      const bearer = bearerOf(req)

      if (route.access === 'admin' && !(bearer && digestsEqual(hashKey(bearer), adminDigest))) {
        req.resume()
        return send(res, { status: 401, body: { error: 'Unauthorized.' } })
      }
      if (route.access === 'session' && !(await manager.authorize(id, bearer))) {
        req.resume()
        return send(res, { status: 401, body: { error: 'Unauthorized.' } })
      }

      if (route.needsTelegram && !config.telegram) {
        req.resume()
        throw telegramNotConfigured()
      }

      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : undefined
      send(res, await route.handle({ id, body, query: url.searchParams }))
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

function bearerOf(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
  return match?.[1]
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
