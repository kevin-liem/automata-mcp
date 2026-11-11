import type { H3Event } from 'h3'
import type { AppMcpTokenClient } from './app-db'

/**
 * Which MCP clients use each connector token — the one module that reads or
 * writes `app.mcp_token_clients`.
 *
 * **A hint, never identity.** Everything recorded here is what the client chose
 * to send in its `initialize`: a thief can call itself `claude-ai` as easily as
 * claude.ai does. It answers support questions ("which client, which version?")
 * and flags a client that turned up late on an established token. Nothing may
 * authorize on it; the controls stay one token per person, scope, revoke,
 * rotate.
 *
 * **Captured in the MCP middleware, from the request body.** We run the toolkit
 * stateless, so the SDK server that handles a `tools/call` never saw the
 * `initialize` and `getClientVersion()` answers undefined there, and
 * `mcp:server:created` fires before the request is handled. The middleware in
 * server/mcp/index.ts reads the raw body instead — safe because h3 caches it
 * and the toolkit's `toWebRequest` replays the cache (verified against h3
 * 1.15.11, toolkit 0.19.0: identical responses with and without the read,
 * bodies of 200 KB intact). **Toolkit or h3 bump = re-check that.**
 *
 * **Only an `initialize` the SDK will accept is recorded**, else the table
 * fills with sessions that never started: the SDK refuses an `initialize`
 * inside a batch ("Only one initialization request is allowed") and one whose
 * `clientInfo` lacks a string `name` or `version`. So: one JSON object, those
 * fields strings, nothing else.
 *
 * **Best-effort.** Same rule as `last_used_at` in `resolveMcpAuth`: a failed
 * write must never fail the request it rode on.
 */

/** Rows kept per token, newest `last_seen` first. */
export const MAX_CLIENTS_PER_TOKEN = 20

const MAX_NAME = 100
const MAX_VERSION = 100
const MAX_PROTOCOL = 100
const MAX_USER_AGENT = 200

/**
 * A client counts as new on a token when its name was first seen more than
 * this long after the token's first client — so setting up two clients on the
 * same day flags neither — and recently enough to still be news.
 */
const NEW_CLIENT_GRACE = '1 day'
const NEW_CLIENT_WINDOW = '14 days'

export interface ClientHello {
  name: string
  version: string
  protocolVersion?: string
  userAgent?: string
}

/** What the token list shows, per client. */
export interface PublicTokenClient {
  name: string
  version: string
  protocolVersion?: string
  userAgent?: string
  firstSeen: string
  /** The last session started — not the last tool call, which is `last_used_at`. */
  lastSeen: string
  sessions: number
  /**
   * First seen on a token that already had other clients — a leak hint only.
   * Absence proves nothing: the name is self-reported.
   */
  newClient: boolean
}

/**
 * Clip client-chosen text for storage: control characters removed (a NUL would
 * fail the write outright, a newline would wreck the table row), whitespace
 * trimmed, at most `max` code points — Postgres's `length()` counts code
 * points, so clipping UTF-16 units could split a pair and still disagree with
 * the CHECK. Shared with tool-calls.ts, whose columns follow the same rule.
 */
export function clipClientText(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim()
  const points = Array.from(clean)
  return points.length > max ? points.slice(0, max).join('') : clean
}

/** A `User-Agent` as both `app.mcp_token_clients` and `app.mcp_tool_calls` store it. */
export function clipUserAgent(userAgent: string | undefined): string | undefined {
  return userAgent ? clipClientText(userAgent, MAX_USER_AGENT) || undefined : undefined
}

/**
 * The client's self-description, if this body is an `initialize` the SDK will
 * accept. Pure; never throws.
 *
 * The substring test runs first so a `tools/call` — whose body can be a 20 000
 * character SQL statement — is not parsed a second time just to learn it is not
 * an `initialize`. A false positive merely costs that parse.
 */
export function parseClientHello(raw: string | undefined, userAgent?: string): ClientHello | undefined {
  if (!raw || !raw.includes('"initialize"')) return undefined

  let message: unknown
  try {
    message = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  // A batch is refused by the SDK when it holds an initialize, so it never
  // starts a session: not recorded.
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined

  const { method, params } = message as { method?: unknown, params?: unknown }
  if (method !== 'initialize' || !params || typeof params !== 'object') return undefined

  const { clientInfo, protocolVersion } = params as { clientInfo?: unknown, protocolVersion?: unknown }
  if (!clientInfo || typeof clientInfo !== 'object') return undefined
  const { name, version } = clientInfo as { name?: unknown, version?: unknown }
  if (typeof name !== 'string' || typeof version !== 'string') return undefined

  return {
    name: clipClientText(name, MAX_NAME),
    version: clipClientText(version, MAX_VERSION),
    protocolVersion: typeof protocolVersion === 'string' ? clipClientText(protocolVersion, MAX_PROTOCOL) || undefined : undefined,
    userAgent: clipUserAgent(userAgent),
  }
}

/**
 * Upsert the client and trim the token to its newest rows, in one transaction.
 *
 * The trim is a second statement rather than a data-modifying CTE: a CTE's
 * DELETE runs on the statement's snapshot, which does not contain the row the
 * INSERT just wrote, so it would keep one row too many. Throws; the request path
 * calls it through `captureTokenClient`, which never lets a failure reach the
 * request.
 */
export async function recordTokenClient(tokenId: string, hello: ClientHello): Promise<void> {
  const sql = await appDb()
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO app.mcp_token_clients
        (token_id, client_name, client_version, protocol_version, user_agent)
      VALUES
        (${tokenId}, ${hello.name}, ${hello.version}, ${hello.protocolVersion ?? null}, ${hello.userAgent ?? null})
      ON CONFLICT (token_id, client_name, client_version) DO UPDATE SET
        last_seen        = now(),
        sessions         = LEAST(app.mcp_token_clients.sessions, 2147483646) + 1,
        protocol_version = EXCLUDED.protocol_version,
        user_agent       = EXCLUDED.user_agent
    `
    await tx`
      DELETE FROM app.mcp_token_clients
      WHERE token_id = ${tokenId}
        AND (client_name, client_version) NOT IN (
          SELECT client_name, client_version FROM app.mcp_token_clients
          WHERE token_id = ${tokenId}
          ORDER BY last_seen DESC, first_seen DESC
          LIMIT ${MAX_CLIENTS_PER_TOKEN}
        )
    `
  })
}

/**
 * Record the client behind this request if the request is an `initialize`,
 * without ever failing or delaying it: `body` is the request body the MCP
 * middleware already decoded (h3 caches the bytes for the toolkit's own read),
 * and the write is not awaited.
 *
 * Call only after the token has authenticated and passed its limit check, so
 * `sessions` counts sessions that were actually served.
 */
export function captureTokenClient(event: H3Event, tokenId: string, body: string | undefined): void {
  const hello = parseClientHello(body, getRequestHeader(event, 'user-agent'))
  if (!hello) return

  void recordTokenClient(tokenId, hello).catch((error) => {
    // Token id only — never the token, never the URL, which may carry it.
    console.error(`[mcp-clients] could not record the client for token ${tokenId}:`, (error as Error)?.message ?? error)
  })
}

/**
 * The clients of each of these tokens, newest session first.
 *
 * Takes token ids the caller has already narrowed — `listTokens` passes the
 * rows its own predicate returned — so the visibility rule (a member sees only
 * their own tokens) carries over without a second statement of it here.
 */
export async function listTokenClients(tokenIds: string[]): Promise<Map<string, PublicTokenClient[]>> {
  const byToken = new Map<string, PublicTokenClient[]>()
  if (!tokenIds.length) return byToken

  const sql = await appDb()
  const rows = await sql<(AppMcpTokenClient & { new_client: boolean })[]>`
    SELECT token_id, client_name, client_version, protocol_version, user_agent,
           first_seen, last_seen, sessions,
           (
             min(first_seen) OVER (PARTITION BY token_id, client_name)
               > min(first_seen) OVER (PARTITION BY token_id) + ${NEW_CLIENT_GRACE}::interval
             AND min(first_seen) OVER (PARTITION BY token_id, client_name)
               > now() - ${NEW_CLIENT_WINDOW}::interval
           ) AS new_client
    FROM app.mcp_token_clients
    WHERE token_id = ANY(${tokenIds}::text[])
    ORDER BY last_seen DESC, first_seen DESC
  `
  for (const row of rows) {
    let list = byToken.get(row.token_id)
    if (!list) byToken.set(row.token_id, list = [])
    list.push({
      name: row.client_name,
      version: row.client_version,
      protocolVersion: row.protocol_version,
      userAgent: row.user_agent,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      sessions: row.sessions,
      newClient: row.new_client,
    })
  }
  return byToken
}
