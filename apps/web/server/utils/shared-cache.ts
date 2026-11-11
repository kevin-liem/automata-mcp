import { REDIS_KEY_PREFIX, logRedisError, readyRedis } from './redis'
import { rememberBounded } from './lookup-cache'

/**
 * Short-lived caches that several replicas can share — through the app's
 * optional Redis (`redis.ts`, `NUXT_REDIS_URL`) when it is set and connected,
 * in-process otherwise. Today: the chat listing (`chats.ts`, #174) and each
 * WhatsApp connection's history setting (`recentHistoryOnly` in `instances.ts`).
 *
 * **Never a failure mode.** Unset — every self-hosted install — means
 * in-process, per replica. Set but unreachable means in-process too, logged by
 * `logRedisError` at most once a minute; never a 503, since a cache that cannot
 * be reached is a slower answer, not a missing one.
 *
 * **What goes in**, on top of `redis.ts`'s rules (`automata:` prefix, a TTL on
 * every key, no `FLUSH*`/`CONFIG`/`KEYS`): keys are `automata:cache:<namespace>:
 * <key>`, values over `MAX_VALUE_BYTES` stay in-process only, and nothing cached
 * here is a credential, a DSN or message content — values are the identifiers
 * and timestamps a listing is made of. Values are never logged.
 *
 * **Single-flight is in-process.** Concurrent callers on one replica share one
 * load; two replicas missing at the same moment each load once. That is still
 * one read per replica per window rather than one per call, and a cross-replica
 * lock would put a Redis round trip and its failure modes in front of every miss.
 *
 * **Failures are never cached.** `load` throwing reaches every caller waiting on
 * it, and the next call loads again. A caller that wants a failure remembered
 * has `staleWhileFailing` in `lookup-cache.ts`.
 */

const KEY_PREFIX = `${REDIS_KEY_PREFIX}cache:`
/** Above this a value is kept in-process only — the rule is "stays small". */
const MAX_VALUE_BYTES = 2 * 1024 * 1024

export interface SharedCacheOptions {
  /** Part of every key, so two caches can never read each other's values. */
  namespace: string
  /** How long a value is served for, in both layers. */
  ttlMs: number
}

/** In-process entries kept per cache, oldest dropped first. */
const MAX_LOCAL_ENTRIES = 500

export interface SharedCache<T> {
  /** The cached value for `key`, or `load()`'s, stored for `ttlMs`. Throws only what `load` throws. */
  get: (key: string, load: () => Promise<T>) => Promise<T>
  /** Drop `key` from both layers — for a change that must show before the TTL runs out. */
  forget: (key: string) => void
}

/** What is stored in Redis: the expiry travels with the value so every replica's memo agrees. */
interface Envelope<T> {
  expiresAt: number
  value: T
}

export function sharedCache<T>(options: SharedCacheOptions): SharedCache<T> {
  const local = new Map<string, Envelope<T>>()
  const inFlight = new Map<string, Promise<T>>()

  function remember(key: string, entry: Envelope<T>) {
    rememberBounded(local, key, entry, MAX_LOCAL_ENTRIES)
  }

  async function refresh(key: string, load: () => Promise<T>): Promise<T> {
    const redisKey = `${KEY_PREFIX}${options.namespace}:${key}`

    const shared = await redisGet<Envelope<T>>(redisKey)
    if (shared && shared.expiresAt > Date.now()) {
      remember(key, shared)
      return shared.value
    }

    const value = await load()
    const entry = { expiresAt: Date.now() + options.ttlMs, value }
    remember(key, entry)
    redisSet(redisKey, entry, options.ttlMs)
    return value
  }

  return {
    get(key, load) {
      const cached = local.get(key)
      if (cached) {
        if (cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
        // Not kept past its TTL: some values (a whole chat listing) are large.
        local.delete(key)
      }

      let pending = inFlight.get(key)
      if (!pending) {
        pending = refresh(key, load).finally(() => inFlight.delete(key))
        inFlight.set(key, pending)
      }
      return pending
    },

    forget(key) {
      local.delete(key)
      const client = readyRedis()
      if (!client) return
      client.del(`${KEY_PREFIX}${options.namespace}:${key}`).catch(error => logRedisError('cache delete', error))
    },
  }
}

// ---------------------------------------------------------------------------

async function redisGet<V>(key: string): Promise<V | undefined> {
  const client = readyRedis()
  if (!client) return undefined
  try {
    const raw = await client.get(key)
    return raw === null ? undefined : JSON.parse(raw) as V
  }
  catch (error) {
    logRedisError('cache read', error)
    return undefined
  }
}

function redisSet(key: string, value: unknown, ttlMs: number): void {
  const client = readyRedis()
  if (!client) return

  let raw: string
  try {
    raw = JSON.stringify(value)
  }
  catch (error) {
    logRedisError('cache encode', error)
    return
  }
  if (Buffer.byteLength(raw) > MAX_VALUE_BYTES) return

  client.set(key, raw, 'PX', Math.max(1, Math.round(ttlMs))).catch(error => logRedisError('cache write', error))
}
