/**
 * Short-lived caches for lookups that can be unavailable rather than empty.
 *
 * The Evolution lookups that go through Baileys — a group's subject, a group's
 * participants — share an awkward shape. They are live round trips to WhatsApp,
 * so they are slow and they never answer at all while the account is
 * disconnected; they are asked for repeatedly, because a picker refetches on
 * every open and an MCP client may call `list-chats` in a loop; and their
 * answers change on a human timescale, so a stale one is nearly always right.
 *
 * Two helpers, because the callers differ in whether they can wait:
 *
 *   staleWhileFailing     the caller awaits the lookup. `fetchParticipants` in
 *                         `mentions.ts`: one group, one call, bounded by a short
 *                         timeout, and the answer it gives is the one it needs.
 *   staleWhileRevalidate  the caller never awaits the lookup. `groupNamesFor` in
 *                         `whatsapp-groups.ts`: its refresh can run paced
 *                         WhatsApp lookups seconds apart, which no request
 *                         could afford to wait for — so it is refreshed in the
 *                         background and the request reads whatever is there.
 *
 * Three behaviours both keep, and each is load-bearing:
 *
 *   serve stale   A failed refresh keeps the value we had rather than
 *                 dropping to nothing: a name from a minute ago still beats a
 *                 raw id on screen.
 *   cache the     For a while. `findChats` and the message listing read
 *   failure       Evolution's database and keep answering while the account is
 *                 disconnected — exactly when these cannot succeed — so without
 *                 this every caller would start the lookup again.
 *   never throw   A caller must still get its messages back when nobody can be
 *                 named, so `load` reports failure as `undefined` and these
 *                 answer with `empty`.
 */
export interface StaleCacheOptions<T> {
  /** How long a good answer is served for. */
  ttlMs: number
  /** How long a failure is served for, before the lookup is tried again. */
  retryTtlMs: number
  /** Answer when a lookup fails and nothing was cached. Shared, so keep it immutable. */
  empty: T
}

/**
 * Returns the `resolve(key, load)` function to cache behind.
 *
 * `load` must resolve to `undefined` for "could not answer" and to a value for
 * "answered", including an answer that is legitimately empty — the two are not
 * the same and only the caller can tell them apart.
 */
export function staleWhileFailing<T>(options: StaleCacheOptions<T>) {
  const entries = new Map<string, { expiresAt: number, value: T }>()
  // Callers that arrive while a key is being loaded wait on that load rather
  // than starting their own: `lidLinks` is a scan of the account's messages, and
  // an MCP client often asks several tools at once.
  const inFlight = new Map<string, Promise<T>>()

  async function refresh(key: string, load: () => Promise<T | undefined>): Promise<T> {
    const loaded = await load()

    if (loaded === undefined) {
      const value = entries.get(key)?.value ?? options.empty
      entries.set(key, { expiresAt: Date.now() + options.retryTtlMs, value })
      return value
    }

    entries.set(key, { expiresAt: Date.now() + options.ttlMs, value: loaded })
    return loaded
  }

  return function resolve(key: string, load: () => Promise<T | undefined>): Promise<T> {
    const cached = entries.get(key)
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.value)

    let pending = inFlight.get(key)
    if (!pending) {
      pending = refresh(key, load).finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return pending
  }
}

/**
 * Returns `peek(key, load, seed?)`: the cached value (or `empty`) right now,
 * with a background `load` started when the entry is missing or expired. `peek`
 * never waits on `load`; it is async only for `seed`, below.
 *
 * At most one `load` is in flight per key. Concurrent readers of a cold entry
 * all get the same answer (`empty`, or the seed) and share the one refresh, which is the point: the first
 * `list-chats` after a deploy must not start one group refresh per caller.
 *
 * A failure — `undefined` or a rejection — keeps the previous value and holds
 * off for `retryTtlMs` before the next attempt, so a source that is down is not
 * asked again on every read.
 *
 * No timers: refreshes are started only by reads, so an account nobody looks at
 * costs nothing, and `load`'s own timeout is what bounds each one. The entries
 * are per process; anything shared between replicas or across restarts is the
 * job of `seed` and of `load` itself.
 *
 * `seed`, when given, is awaited once for a key with no entry at all — a cold
 * process. It must be cheap (`groupNamesFor` reads one indexed table in the app
 * database and one in Evolution's, never WhatsApp), since the request waits on
 * it. Per call rather than per cache, since it usually needs more than the key. What it returns is
 * served at once but stored already expired, so the same call still starts the
 * real refresh; and because a failed refresh keeps the previous value, a seeded
 * value is what an account that cannot be refreshed keeps showing. Concurrent
 * cold readers share one seed. A seed that fails or finds nothing stores
 * nothing, and the read falls through to `empty` as it would without one.
 */
export function staleWhileRevalidate<T>(options: StaleCacheOptions<T>) {
  const entries = new Map<string, { expiresAt: number, value: T }>()
  const inFlight = new Set<string>()
  const seeding = new Map<string, Promise<void>>()

  function seedOnce(key: string, seed: () => Promise<T | undefined>): Promise<void> {
    let pending = seeding.get(key)
    if (!pending) {
      pending = Promise.resolve()
        .then(seed)
        .then(
          (seeded) => {
            // A refresh may have settled while the seed was being read; it wins.
            if (seeded !== undefined && !entries.has(key)) entries.set(key, { expiresAt: 0, value: seeded })
          },
          () => {},
        )
        .finally(() => seeding.delete(key))
      seeding.set(key, pending)
    }
    return pending
  }

  function settle(key: string, loaded: T | undefined) {
    if (loaded === undefined) {
      const value = entries.get(key)?.value ?? options.empty
      entries.set(key, { expiresAt: Date.now() + options.retryTtlMs, value })
      return
    }
    entries.set(key, { expiresAt: Date.now() + options.ttlMs, value: loaded })
  }

  return async function peek(
    key: string,
    load: () => Promise<T | undefined>,
    seed?: () => Promise<T | undefined>,
  ): Promise<T> {
    if (seed && !entries.has(key)) await seedOnce(key, seed)

    const cached = entries.get(key)
    const fresh = cached !== undefined && Date.now() < cached.expiresAt

    if (!fresh && !inFlight.has(key)) {
      inFlight.add(key)
      // `Promise.resolve().then` so a `load` that throws synchronously is
      // caught here too, rather than escaping into the request.
      Promise.resolve()
        .then(load)
        .then(
          loaded => settle(key, loaded),
          () => settle(key, undefined),
        )
        .finally(() => inFlight.delete(key))
    }

    return cached?.value ?? options.empty
  }
}

/**
 * Set `key` as the newest entry of an insertion-ordered map, then drop the
 * oldest entries until `max` remain. The bounded-map idiom every in-process
 * memo here uses: re-inserting moves a key to the end, so the first key is
 * always the one touched longest ago.
 */
export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value as K)
}
