import type { AppInstance } from './app-db'
import type { McpAuth } from './mcp-auth'

/**
 * The one Evolution API client. Everything funnels through
 * `createEvolutionClient`, so the base URL and the `apikey` header are defined
 * in exactly one place.
 *
 * Two kinds of credential, and the distinction is a security boundary:
 *
 *   admin     a *global* key. Creates and deletes instances. Two callers, both
 *             in instances.ts. Either the deployment's own key from
 *             runtimeConfig, or a key the user supplied for their own server —
 *             and the two are never cross-paired, see
 *             `evolutionAdminCredentials`.
 *   instance  the per-instance token Evolution returns from /instance/create.
 *             Everything else. Evolution scopes it to that one instance itself.
 *
 * A third distinction cuts across both: whether the base URL came from this
 * deployment's configuration or from a user. A user-supplied one is an
 * outbound request to an address a user chose, so it goes through the host
 * guard — see `userSupplied` below.
 */

/**
 * Compare two Evolution base URLs the way a person would.
 *
 * A raw string comparison makes a trailing slash, a case change or an added
 * default port look like a different server — and every pre-existing row stored
 * `base_url` copied from `config.evolutionUrl`, so one cosmetic edit to that
 * variable would reclassify all of them as bring-your-own. They would then be
 * host-guarded, and a compose address such as `http://evolution:8080` is
 * correctly refused, so status, QR and sending would all start answering 422.
 */
export function sameEvolutionServer(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  try {
    return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase()
  }
  catch {
    return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
  }
}

export interface EvolutionCredentials {
  baseUrl: string
  apiKey: string
  /**
   * True when `baseUrl` came from a user rather than from runtimeConfig.
   *
   * Only these are guarded. Our own configured Evolution URL must NOT be: it
   * legitimately sits on a private compose network, and `net-guard` would
   * (correctly) refuse it as this deployment's own infrastructure.
   */
  userSupplied?: boolean
}

export type EvolutionClient = ReturnType<typeof createEvolutionClient>

export function createEvolutionClient(creds: EvolutionCredentials) {
  return $fetch.create({
    baseURL: creds.baseUrl,
    headers: { apikey: creds.apiKey },
    retry: 0,

    /**
     * Host guard for user-supplied servers, re-checked on every request rather
     * than only when the URL was saved. A hostname that passed at save time can
     * be re-pointed at 127.0.0.1 afterwards, and nothing would notice.
     *
     * **This checks; it does not pin.** `$fetch` resolves DNS itself, so a name
     * that answers publicly here and privately a millisecond later still wins —
     * a rebinding window this cannot close. Closing it needs the connection to
     * be dialled at the address we approved, which for HTTP means an undici
     * `Agent` with a `connect` hook (`undici` is not a direct dependency today);
     * `pg-pool.ts` does exactly that for Postgres, where postgres.js takes a
     * `host` option and no extra dependency is needed. The database path is the
     * wider exposure of the two, and it is the one that is pinned.
     */
    async onRequest({ options }) {
      // A hard deadline on every request, body included, and on ours as well
      // as user-supplied ones: ofetch's own `timeout` is cleared once headers
      // arrive, so a server trickling its body would otherwise hold the caller
      // for ever (GHSA-g2cf-mx92-xc53). A caller's `timeout` becomes this
      // end-to-end deadline. See deadline.ts.
      applyRequestDeadline(options)
      if (!creds.userSupplied) return
      await assertPublicUrl(creds.baseUrl, 'Evolution server URL')
      // Refuse a redirect off the approved host rather than following it.
      options.redirect = 'error'
    },
  })
}

/**
 * Global-key client. Only `POST /instance/create` and `DELETE /instance/delete`
 * require it — Evolution's auth guard accepts an instance's own token for every
 * other route.
 *
 * Do not reach for this anywhere else. A request authenticated with this key
 * can see and act on every user's instance.
 */
export function evolutionAdminCredentials(
  server?: Pick<AppInstance, 'base_url' | 'admin_key'>,
): EvolutionCredentials | undefined {
  const config = useRuntimeConfig()

  // A row that carries its own global key is a bring-your-own server, and both
  // halves come from it.
  if (server?.admin_key) {
    if (!server.base_url) return undefined
    return { baseUrl: server.base_url, apiKey: server.admin_key, userSupplied: true }
  }

  // No key on the row: this connection uses the deployment default. `base_url`
  // is stored on EVERY row, including these, so its mere presence does not make
  // a row bring-your-own — reading it that way refuses to delete an ordinary
  // connection, which is exactly the bug this comment replaced.
  //
  // But a row naming a *different* server with no key of its own is genuinely
  // unusable, and must not be completed from ours: sending our global key to a
  // server the user chose hands them a credential that reaches every account on
  // our Evolution. That is the case this returns undefined for.
  if (server && !onDeploymentServer(server)) return undefined

  if (!config.evolutionUrl || !config.evolutionAdminKey) return undefined
  return { baseUrl: config.evolutionUrl, apiKey: config.evolutionAdminKey }
}

/**
 * Credentials for one connected account.
 *
 * There is deliberately NO fallback to a global key. If `api_key` is missing
 * the caller gets `undefined` and must fail. Falling back would silently give
 * an MCP token holder global Evolution access across every user's instance.
 *
 * That now has a sharper edge: `instance.admin_key` is a global key sitting on
 * the very record this function reads. It must never be read here. The type
 * below picks its two fields deliberately so `admin_key` is not even in scope.
 *
 * The base URL may fall back to config: it is not a secret, and it lets an
 * existing instance keep working if the deployment URL changes.
 */
export function credentialsForInstance(instance: Pick<AppInstance, 'base_url' | 'api_key'>): EvolutionCredentials | undefined {
  const configUrl = useRuntimeConfig().evolutionUrl
  const baseUrl = instance.base_url || configUrl
  if (!baseUrl || !instance.api_key) return undefined
  // Anything that is not the server we configured is a server a user chose, so
  // it is guarded. Derived rather than stored, so a row that stops matching our
  // configuration starts being guarded rather than quietly staying exempt.
  return { baseUrl, apiKey: instance.api_key, userSupplied: !sameEvolutionServer(baseUrl, configUrl) }
}

/** For UI API routes, where the instance was read from the app database. */
export function evolutionClientForInstance(instance: AppInstance): EvolutionClient {
  const creds = credentialsForInstance(instance)
  if (!creds) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This WhatsApp account is not fully provisioned',
    })
  }
  return createEvolutionClient(creds)
}

/**
 * For MCP tool handlers.
 *
 * Tool handlers are called by the MCP SDK with its own `RequestHandlerExtra` —
 * there is no H3 event in scope. `useEvent()` recovers it from Nitro's async
 * context, which is why `nitro.experimental.asyncContext` is enabled in
 * nuxt.config.ts.
 *
 * Reads `event.context.mcpAuth` and nothing else. There is no branch here that
 * can reach a browser session; that separation is the point.
 */
export function useEvolutionClient(): EvolutionClient {
  const event = useEvent()
  const auth = event.context.mcpAuth as McpAuth | undefined

  if (!auth) {
    // Unreachable in practice — server/mcp/index.ts returns 401 before any tool
    // is registered. If it ever fires, something bypassed the auth middleware,
    // and failing closed is the only correct response.
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  if (auth.kind !== 'whatsapp') {
    // Also unreachable: every tool that calls this is gated on kind in its
    // `enabled` guard. Fail closed anyway — reaching Evolution on behalf of a
    // connection that is not a WhatsApp account has no correct meaning.
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  return createEvolutionClient(auth.evolution)
}

/**
 * The entries of Evolution's error envelope (`data.response.message`), which
 * is a string or an array of strings and objects depending on the route.
 * Re-verify on an Evolution tag bump.
 */
export function evolutionErrorEntries(error: unknown): unknown[] {
  const raw = (error as { data?: { response?: { message?: unknown } } } | undefined)?.data?.response?.message
  return Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
}

/**
 * Turn a failed `POST /message/sendText` into an answer the caller can act on.
 *
 * ofetch's own message is only `[POST] "…": 400 Bad Request`, and the MCP
 * toolkit relays exactly that, so a model told "400" can neither fix its call
 * nor tell the user why. Evolution 2.3.7 answers 400 with
 * `{ status, error, response: { message: [...] } }` for three unrelated reasons:
 *
 *   - recipient not on WhatsApp: `sendMessageWithTyping` throws
 *     `BadRequestException(isWA)`, so the entry is `{ exists: false, jid, number }`
 *   - route schema validation: plain strings naming the field
 *   - the send itself failed: the same method's `catch` wraps *any* error as
 *     `BadRequestException(error.toString())`, so a dead socket arrives as a 400
 *     reading `Error: Connection Closed`
 *
 * Each gets its own status. A handled error is invisible to Nitro, so every
 * branch logs the classification (never the message text or recipient). The
 * dead-socket branch also records the evidence `stalled` is built from
 * (`noteSocketDead`, socket-evidence.ts).
 * Re-verify the envelope and those three throw sites on an Evolution tag bump.
 */
export function relayEvolutionSendError(error: unknown, number: string, instanceId: string): never {
  const status = httpStatusOf(error)
  const entries = evolutionErrorEntries(error)

  if (status === 400) {
    if (entries.some(e => typeof e === 'object' && e !== null && (e as { exists?: unknown }).exists === false)) {
      console.error(`[evolution] send on connection ${instanceId} refused: recipient is not a WhatsApp account`)
      throw createError({
        statusCode: 422,
        message: number.includes('@')
          ? `"${number}" is not a WhatsApp account, so nothing was sent. Pass a chat's jid exactly as list-chats or read-messages return it.`
          // Bare digits: either a mistyped number or a LID with its suffix
          // stripped. The second is worth naming — retrying with the digits
          // reformatted would only try another stranger's number.
          : `"${number}" is not a WhatsApp account, so nothing was sent. Pass the number in international format with the country code, digits only — no "+", spaces or dashes (e.g. 5511999999999). If these digits came from a jid ending in @lid, they are not a phone number: pass the full jid instead.`,
      })
    }

    const texts = entries.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
    if (namesDeadSocket(texts) || texts.some(t => /timed out/i.test(t))) {
      console.error(`[evolution] send on connection ${instanceId} failed: WhatsApp socket not connected`)
      // The evidence a dead socket under a live `open` leaves (#205) — the
      // status read turns it into `stalled`. Not on `Timed Out`, which a
      // healthy socket can answer too; see socket-evidence.ts.
      if (namesDeadSocket(texts)) noteSocketDead({ id: instanceId }, 'send')
      throw createError({
        statusCode: 503,
        message: 'The WhatsApp connection is down, so the message was not sent. Check get-connection-status: when sessionLost is true the account owner can press Reconnect on the connection\'s page in the web app; when stalled is true the Evolution service has to be restarted, and retrying the send will not help until it is.',
      })
    }

    if (texts.length) {
      console.error(`[evolution] send on connection ${instanceId} refused with 400`)
      const detail = texts.join('; ')
      throw createError({
        statusCode: 400,
        message: `WhatsApp refused the message: ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`,
      })
    }
  }

  console.error(`[evolution] send on connection ${instanceId} failed: Evolution answered ${status ?? (error as Error | undefined)?.message ?? 'nothing'}`)
  throw createError({
    statusCode: 503,
    message: 'The WhatsApp server did not accept the message, so it was not sent. Check get-connection-status and try again.',
  })
}
