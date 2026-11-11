import Redis from 'ioredis'

/**
 * The app's optional Redis, from `NUXT_REDIS_URL`. Set on the hosted offering's
 * web service; self-hosted deployments normally leave it unset, and nothing may
 * require it. Users: the MCP rate limit (mcp-rate-limit.ts) and the shared
 * caches (shared-cache.ts), which both fall back to in-process state when
 * `readyRedis()` answers `undefined` or a command fails.
 *
 * | `NUXT_REDIS_URL` | behaviour |
 * |---|---|
 * | unset | `undefined`; callers use in-process state |
 * | set, unreachable | commands fail fast (no offline queue, short timeouts); callers fall back, never 503 |
 * | set, reachable | state shared across replicas and kept across deploys |
 *
 * **Rules for every key written here**, because the operator may point this at
 * a Redis shared with something else (Evolution's cache uses database `/6`):
 * every key starts with `automata:` and carries a TTL; nothing here runs
 * `FLUSHALL`, `FLUSHDB`, `CONFIG` or `KEYS`. Never pick up Evolution's
 * `CACHE_REDIS_URI` automatically — sharing is the operator's call.
 *
 * The URL may carry a password, so it is never logged; errors are logged by
 * message, at most once a minute per context.
 */

export const REDIS_KEY_PREFIX = 'automata:'

/** Fail fast: this sits on the MCP auth path, and the fallback is always available. */
const COMMAND_TIMEOUT_MS = 250
const CONNECT_TIMEOUT_MS = 2_000
const LOG_EVERY_MS = 60_000

let client: Redis | undefined
let configured: boolean | undefined
const lastLoggedAt = new Map<string, number>()

/** Whether `NUXT_REDIS_URL` is set at all. */
export function redisConfigured(): boolean {
  if (configured === undefined) configured = Boolean(String(useRuntimeConfig().redisUrl ?? '').trim())
  return configured
}

/**
 * The shared client, created on first use; `undefined` when unset. Ready or
 * not: with the offline queue off, a command on a client that is not connected
 * rejects at once, which callers treat like any other failure.
 */
export function redisClient(): Redis | undefined {
  if (!redisConfigured()) return undefined
  if (client) return client

  client = new Redis(String(useRuntimeConfig().redisUrl).trim(), {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    // Keep trying in the background, capped, so Redis coming back is picked up
    // without a restart.
    retryStrategy: times => Math.min(times * 500, 10_000),
  })
  // Without a listener, ioredis prints every connection error. One line a
  // minute is enough to say the fallback is in use.
  client.on('error', error => logRedisError('connection', error))
  return client
}

/**
 * The client only once connected; `undefined` when unset or down. Callers go
 * straight to their fallback while Redis is down, rather than paying one
 * rejected command per request.
 */
export function readyRedis(): Redis | undefined {
  const redis = redisClient()
  return redis?.status === 'ready' ? redis : undefined
}

/**
 * Log a Redis failure, at most once a minute per context, so one caller's
 * errors never mute another's. Message only — never the URL.
 */
export function logRedisError(context: string, error: unknown): void {
  const now = Date.now()
  if (now - (lastLoggedAt.get(context) ?? 0) < LOG_EVERY_MS) return
  lastLoggedAt.set(context, now)
  console.warn(`[redis] ${context} failed, using in-process state instead:`, (error as Error)?.message ?? error)
}
