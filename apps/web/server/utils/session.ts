import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppUser } from './app-db'

/**
 * Browser sessions — and ONLY the browser UI.
 *
 * Nothing here is reachable from the MCP surface: server/middleware/session.ts
 * returns early on /mcp before this ever runs, and MCP tools read
 * `event.context.mcpAuth` instead. Keep it that way — a shared "get current
 * user" helper across both surfaces is exactly the bug this split prevents.
 *
 * The cookie holds 32 random bytes; `app.sessions` holds only their SHA-256 —
 * the same handling an MCP token gets, so a database read does not hand anyone
 * a live session. A session lasts 14 days and is extended whenever it is used
 * with less than half of that left, so an active user is never bounced to the
 * login page mid-week.
 */

export const SESSION_COOKIE = 'automata_session'

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The flags every auth cookie carries — the session's, and the short-lived one
 * a sign-in holds while it owes a second factor (`mfa.ts`).
 */
export function authCookieOptions(path = '/') {
  return { httpOnly: true, secure: !import.meta.dev, sameSite: 'lax' as const, path }
}

function writeSessionCookie(event: H3Event, token: string, expiresAt: Date): void {
  setCookie(event, SESSION_COOKIE, token, { ...authCookieOptions(), expires: expiresAt })
}

export function clearSessionCookie(event: H3Event): void {
  setCookie(event, SESSION_COOKIE, '', { ...authCookieOptions(), maxAge: 0 })
}

/** The stored hash of this request's session cookie, if it carries one. */
export function currentSessionHash(event: H3Event): string | undefined {
  const token = getCookie(event, SESSION_COOKIE)
  return token ? hashSessionToken(token) : undefined
}

/** Start a session for this user and set its cookie. */
export async function startSession(event: H3Event, userId: string): Promise<void> {
  const sql = await appDb()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await sql`
    INSERT INTO app.sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashSessionToken(token)}, ${expiresAt})
  `
  // Opportunistic cleanup, so expired rows do not accumulate with no timer.
  void sql`DELETE FROM app.sessions WHERE user_id = ${userId} AND expires_at < now()`.catch(() => {})

  writeSessionCookie(event, token, expiresAt)
}

/** End the session this request carries, if any, and clear the cookie. */
export async function endSession(event: H3Event): Promise<void> {
  const token = getCookie(event, SESSION_COOKIE)
  clearSessionCookie(event)
  if (!token) return

  const sql = await appDb()
  await sql`DELETE FROM app.sessions WHERE token_hash = ${hashSessionToken(token)}`
}

/**
 * Every other session this user has, gone — after a password change, so a
 * session someone else opened with the old password does not outlive it.
 */
export async function endOtherSessions(event: H3Event, userId: string): Promise<void> {
  const sql = await appDb()
  await sql`
    DELETE FROM app.sessions
    WHERE user_id = ${userId} AND token_hash <> ${currentSessionHash(event) ?? ''}
  `
}

interface SessionRow extends AppUser {
  session_id: string
  expires_at: string
}

/**
 * The user this request's cookie belongs to, or `undefined`.
 *
 * `undefined` only for a cookie that is genuinely no good — absent, unknown,
 * expired, or whose user is gone. A database fault is a **503**: answering 401
 * there signs every user out in the middle of an outage, and the client reads
 * it as "your session ended" rather than "the backend is down". Same
 * distinction `resolveMcpAuth` makes for tokens.
 */
export async function getSessionUser(event: H3Event): Promise<AppUser | undefined> {
  const token = getCookie(event, SESSION_COOKIE)
  if (!token) return undefined

  let row: SessionRow | undefined
  try {
    const sql = await appDb()
    ;[row] = await sql<SessionRow[]>`
      SELECT u.id, u.email, u.name, s.id AS session_id, s.expires_at
      FROM app.sessions s JOIN app.users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashSessionToken(token)} AND s.expires_at > now()
    `

    // Sliding renewal, at most once per half-life rather than on every request.
    if (row && new Date(row.expires_at).getTime() - Date.now() < SESSION_TTL_MS / 2) {
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
      await sql`UPDATE app.sessions SET expires_at = ${expiresAt} WHERE id = ${row.session_id}`
      writeSessionCookie(event, token, expiresAt)
    }
  }
  catch (cause) {
    console.error('[session] could not validate a session cookie against the app database:', cause)
    throw appDbUnavailable(cause)
  }

  if (!row) return undefined
  return { id: row.id, email: row.email, name: row.name }
}

/** The signed-in user, or 401. For UI API routes. */
export async function requireSessionUser(event: H3Event): Promise<AppUser> {
  const user = event.context.user as AppUser | undefined ?? await getSessionUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Not signed in' })
  }
  return user
}
