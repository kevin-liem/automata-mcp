import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { AppUser, Db } from './app-db'

/**
 * Accounts and passwords — the web UI's half of the auth split.
 *
 * Nothing here is reachable from the MCP surface. `server/middleware/session.ts`
 * returns early on /mcp before the cookie is ever read, and MCP tools resolve
 * `event.context.mcpAuth` through `mcp-auth.ts` instead.
 *
 * ── Passwords ───────────────────────────────────────────────────────────────
 *
 * scrypt from `node:crypto`, with the parameters in the stored string so they
 * can be raised later without a migration. Rows imported from PocketBase carry
 * its bcrypt hashes; those still verify, and are replaced by scrypt on that
 * user's next successful sign-in, so the bcrypt path empties itself out.
 *
 * Sessions are in `session.ts`.
 */

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 64 }

function scryptAsync(password: string, salt: Buffer, params: typeof SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$')
}

/**
 * Check a password against a stored hash. Answers whether it matched and
 * whether the stored hash should be replaced with a current one.
 */
async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean, rehash: boolean }> {
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, key] = stored.split('$')
    const expected = Buffer.from(key ?? '', 'base64')
    const params = { N: Number(n), r: Number(r), p: Number(p), keyLength: expected.length }
    if (!expected.length || !Number.isInteger(params.N)) return { ok: false, rehash: false }

    const actual = await scryptAsync(password, Buffer.from(salt ?? '', 'base64'), params)
    const ok = actual.length === expected.length && timingSafeEqual(actual, expected)
    return { ok, rehash: ok && (params.N !== SCRYPT.N || params.r !== SCRYPT.r || params.p !== SCRYPT.p) }
  }

  // PocketBase's format. Accounts imported from it keep a bcrypt hash until
  // their first sign-in since; remove this branch once none are left
  // (`SELECT count(*) FROM app.users WHERE password_hash NOT LIKE 'scrypt$%'`).
  if (/^\$2[aby]\$/.test(stored)) {
    const ok = await bcrypt.compare(password, stored)
    return { ok, rehash: ok }
  }

  return { ok: false, rehash: false }
}

/**
 * A hash to compare against when the email matches no account, so "no such
 * user" and "wrong password" take the same time and an address cannot be
 * probed by timing the login form.
 */
let decoy: Promise<string> | undefined

interface PasswordRow extends AppUser {
  password_hash: string
}

/**
 * The user with this email and password, or `undefined` if either is wrong.
 * A database fault throws 503 — never `undefined`, which the caller turns into
 * "invalid email or password".
 */
export async function checkPassword(email: string, password: string): Promise<AppUser | undefined> {
  let row: PasswordRow | undefined
  try {
    const sql = await appDb()
    ;[row] = await sql<PasswordRow[]>`
      SELECT id, email, name, password_hash FROM app.users WHERE email = ${normaliseEmail(email)}
    `
  }
  catch (cause) {
    console.error('[account] could not read an account to check a password:', cause)
    throw appDbUnavailable(cause)
  }

  if (!row) {
    decoy ??= hashPassword(randomBytes(16).toString('hex'))
    await verifyPassword(password, await decoy)
    return undefined
  }

  const { ok, rehash } = await verifyPassword(password, row.password_hash)
  if (!ok) return undefined

  if (rehash) {
    // Best effort: the sign-in has already succeeded on the old hash.
    await setPassword(row.id, password).catch((error) => {
      console.error(`[account] could not upgrade the password hash for ${row.id}:`, error)
    })
  }

  return { id: row.id, email: row.email, name: row.name }
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const sql = await appDb()
  const hash = await hashPassword(password)
  await sql`UPDATE app.users SET password_hash = ${hash}, updated = now() WHERE id = ${userId}`
}

/**
 * Create an account inside the caller's transaction. Throws 409 when the
 * address is taken. Takes a finished hash so the slow part runs before the
 * transaction opens rather than while it holds a connection.
 *
 * `marketingConsent` is the hosted signup page's opt-in box; callers pass it
 * only in hosted mode, so a self-hosted account never records one.
 */
export async function createUser(
  tx: Db,
  input: { email: string, passwordHash: string, name: string, marketingConsent?: boolean },
): Promise<AppUser> {
  try {
    const [row] = await tx<AppUser[]>`
      INSERT INTO app.users (email, name, password_hash, marketing_consent_at)
      VALUES (
        ${normaliseEmail(input.email)}, ${input.name}, ${input.passwordHash},
        CASE WHEN ${Boolean(input.marketingConsent)} THEN now() END
      )
      RETURNING id, email, name
    `
    return row!
  }
  catch (error) {
    if (isUniqueViolation(error)) {
      throw createError({ statusCode: 409, statusMessage: 'That email is already registered' })
    }
    throw error
  }
}

/** The 401 every login path answers, whichever of email and password was wrong. */
export function authFailed(): Error {
  return createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
}

/**
 * Prove the signed-in user's current password before a credential change.
 * Wrong is 403 — they are signed in, so this is not an authentication failure.
 *
 * Throttled per account, ten wrong answers per fifteen minutes, through the
 * same `claimAuthAttempt` the second-factor step uses (via `withAuthAttempt`),
 * under `reauth:<id>`.
 * Without it the password stopped being a second proof beyond the cookie: a
 * stolen session could guess it here at scrypt speed, with no cap, and then
 * change the email or add its own second factor (GHSA-ggj4-ccmm-p6ww).
 * Claimed before the comparison so a concurrent burst counts; handed back on
 * a right answer and on an outage (503), which is not a wrong guess.
 */
export async function requireCurrentPassword(user: AppUser, password: string): Promise<void> {
  const ok = await withAuthAttempt(`reauth:${user.id}`, () => checkPassword(user.email, password), ok => !ok)
  if (!ok) {
    throw createError({ statusCode: 403, statusMessage: 'Current password is incorrect' })
  }
}
