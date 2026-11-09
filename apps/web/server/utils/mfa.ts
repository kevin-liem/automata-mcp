import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { Db } from './app-db'

/**
 * Second factors for the web sign-in: authenticator-app codes, passkeys and
 * security keys (`webauthn.ts`), and single-use recovery codes.
 *
 * Browser UI only. Connector tokens are their own credential and nothing here
 * is consulted on the MCP surface.
 *
 * **A row in `app.sessions` means fully signed in.** A sign-in that passed the
 * password and still owes a factor is a row in `app.mfa_challenges` plus a
 * cookie scoped to `/api/auth/login`, and becomes a session only through
 * `finishLoginChallenge()`. So `getSessionUser`, the session middleware and
 * every `requireSessionUser` caller are unchanged — none of them can be handed
 * a half-finished sign-in, because none of them can see one.
 *
 * A challenge allows five answers and is then deleted; the password has to be
 * typed again for another five. Each answer claims its attempt *before* it is
 * checked, so five requests in flight at once spend all five, and an account has
 * one live sign-in at a time, so the five cannot be multiplied across cookies.
 * That cap is the control. The per-account throttle below is a speed bump on
 * top, as for invitation mail.
 */

export const MFA_COOKIE = 'automata_mfa'
const MFA_COOKIE_PATH = '/api/auth/login'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const MAX_CHALLENGE_ATTEMPTS = 5
const RECOVERY_CODE_COUNT = 10

export interface UserFactors {
  totp: boolean
  passkeys: number
  recoveryRemaining: number
}

export function hasSecondFactor(factors: UserFactors): boolean {
  return factors.totp || factors.passkeys > 0
}

/**
 * Which factors this user has. One definition of "has 2FA" — a confirmed
 * authenticator app or at least one passkey — for login and settings alike.
 * Recovery codes alone are not a factor: they exist only beside one.
 */
export async function userFactors(db: Db, userId: string): Promise<UserFactors> {
  const [row] = await db<{ totp: boolean, passkeys: number, recovery: number }[]>`
    SELECT
      EXISTS (SELECT 1 FROM app.totp_credentials WHERE user_id = ${userId} AND confirmed_at IS NOT NULL) AS totp,
      (SELECT count(*)::int FROM app.webauthn_credentials WHERE user_id = ${userId}) AS passkeys,
      (SELECT count(*)::int FROM app.recovery_codes WHERE user_id = ${userId} AND used_at IS NULL) AS recovery
  `
  return { totp: row!.totp, passkeys: row!.passkeys, recoveryRemaining: row!.recovery }
}

export type LoginMethod = 'totp' | 'webauthn' | 'recovery'

export function loginMethods(factors: UserFactors): LoginMethod[] {
  const methods: LoginMethod[] = []
  if (factors.totp) methods.push('totp')
  if (factors.passkeys > 0) methods.push('webauthn')
  if (factors.recoveryRemaining > 0) methods.push('recovery')
  return methods
}

// ── the sign-in challenge ──────────────────────────────────────────────────

export interface LoginChallenge {
  id: string
  user_id: string
  email: string
  webauthn_challenge?: string
  attempts: number
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Password accepted, factor owed: record that and hand the browser its cookie.
 *
 * Replaces any sign-in the account already had pending. Otherwise someone
 * holding the password signs in K times and spreads guesses over K challenges,
 * five each. The user row lock serialises two sign-ins racing, so both cannot
 * delete before either inserts and leave two alive. The cost is that a sign-in
 * left half-finished in another tab expires.
 */
export async function startLoginChallenge(event: H3Event, userId: string): Promise<void> {
  const sql = await appDb()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)

  await sql.begin(async (tx) => {
    await lockUserFactors(tx, userId)
    await tx`
      DELETE FROM app.mfa_challenges
      WHERE user_id = ${userId} AND (purpose = 'login' OR expires_at < now())
    `
    await tx`
      INSERT INTO app.mfa_challenges (user_id, purpose, token_hash, expires_at)
      VALUES (${userId}, 'login', ${hashToken(token)}, ${expiresAt})
    `
  })

  setCookie(event, MFA_COOKIE, token, { ...authCookieOptions(MFA_COOKIE_PATH), expires: expiresAt })
}

export function clearLoginChallengeCookie(event: H3Event): void {
  setCookie(event, MFA_COOKIE, '', { ...authCookieOptions(MFA_COOKIE_PATH), maxAge: 0 })
}

/**
 * The sign-in this request's challenge cookie belongs to, or `undefined`.
 *
 * Same failure rule as `getSessionUser`: `undefined` only when the read ran and
 * found nothing usable; a database fault is a 503. Answering 401 there would
 * send someone back to the password step in the middle of an outage.
 */
export async function resolveLoginChallenge(event: H3Event): Promise<LoginChallenge | undefined> {
  const token = getCookie(event, MFA_COOKIE)
  if (!token) {
    console.warn('[mfa] second-factor request carried no challenge cookie')
    return undefined
  }

  let row: LoginChallenge | undefined
  try {
    const sql = await appDb()
    ;[row] = await sql<LoginChallenge[]>`
      SELECT c.id, c.user_id, u.email, c.webauthn_challenge, c.attempts
      FROM app.mfa_challenges c JOIN app.users u ON u.id = c.user_id
      WHERE c.token_hash = ${hashToken(token)}
        AND c.purpose = 'login'
        AND c.expires_at > now()
        AND c.attempts < ${MAX_CHALLENGE_ATTEMPTS}
    `
  }
  catch (cause) {
    console.error('[mfa] could not read a sign-in challenge from the app database:', cause)
    throw appDbUnavailable(cause)
  }

  if (!row) console.warn('[mfa] sign-in challenge is unknown, expired or out of attempts')
  return row
}

/** The 401 for a challenge that is gone: start again from the password. */
export function loginChallengeExpired(): Error {
  return createError({
    statusCode: 401,
    statusMessage: 'Your sign-in expired. Enter your password again.',
    data: { code: 'mfa_expired' },
  })
}

/**
 * Spend one of the challenge's attempts, before the answer is looked at, and
 * return which attempt this is. Counting after the check let every request that
 * read `attempts = 0` at the start have a guess, however many arrived at once.
 * The increment is one conditional statement, so no two requests claim the same
 * attempt and none claims a sixth; one that finds nothing left gets the 401 that
 * sends it back to the password.
 */
export async function claimLoginAttempt(challenge: LoginChallenge): Promise<number> {
  let row: { attempts: number } | undefined
  try {
    const sql = await appDb()
    ;[row] = await sql<{ attempts: number }[]>`
      UPDATE app.mfa_challenges SET attempts = attempts + 1
      WHERE id = ${challenge.id}
        AND purpose = 'login'
        AND expires_at > now()
        AND attempts < ${MAX_CHALLENGE_ATTEMPTS}
      RETURNING attempts
    `
    if (!row) await sql`DELETE FROM app.mfa_challenges WHERE id = ${challenge.id}`
  }
  catch (cause) {
    console.error('[mfa] could not count a sign-in attempt in the app database:', cause)
    throw appDbUnavailable(cause)
  }

  if (!row) {
    console.warn(`[mfa] sign-in challenge for user ${challenge.user_id} is out of attempts`)
    throw loginChallengeExpired()
  }
  return row.attempts
}

/**
 * The answer to `attempt` was wrong. The attempt is already spent; the last one
 * deletes the challenge, so the next try needs the password again.
 */
export async function failLoginChallenge(challenge: LoginChallenge, attempt: number, reason: string): Promise<Error> {
  console.warn(`[mfa] second factor refused for user ${challenge.user_id} (attempt ${attempt}): ${reason}`)

  if (attempt >= MAX_CHALLENGE_ATTEMPTS) {
    const sql = await appDb()
    await sql`DELETE FROM app.mfa_challenges WHERE id = ${challenge.id}`
    return loginChallengeExpired()
  }
  return createError({ statusCode: 401, statusMessage: 'That code is not valid', data: { code: 'mfa_invalid' } })
}

/**
 * The factor checked out: the challenge is spent and the session begins. The
 * delete is conditional, so a challenge answered twice at once starts one
 * session, not two.
 */
export async function finishLoginChallenge(event: H3Event, challenge: LoginChallenge): Promise<void> {
  const sql = await appDb()
  const [spent] = await sql`DELETE FROM app.mfa_challenges WHERE id = ${challenge.id} RETURNING id`
  clearLoginChallengeCookie(event)
  if (!spent) throw loginChallengeExpired()
  await startSession(event, challenge.user_id)
}

// ── authenticator app ──────────────────────────────────────────────────────

/**
 * Check a code against the user's confirmed authenticator and spend its step.
 *
 * `last_step` only moves forward, in one conditional `UPDATE`, so a code that
 * was seen — over a shoulder, in a proxy log — cannot be used a second time,
 * and two requests racing with the same code cannot both pass.
 */
export async function consumeTotpCode(db: Db, userId: string, code: string, confirmed = true): Promise<boolean> {
  const [row] = await db<{ secret: string }[]>`
    SELECT secret FROM app.totp_credentials
    WHERE user_id = ${userId} AND (confirmed_at IS NOT NULL) = ${confirmed}
  `
  if (!row) return false

  const step = matchTotp(row.secret, code)
  if (step === undefined) return false

  const [spent] = await db`
    UPDATE app.totp_credentials SET last_step = ${step}
    WHERE user_id = ${userId} AND last_step < ${step}
    RETURNING user_id
  `
  if (!spent) console.warn(`[mfa] authenticator code for user ${userId} was already used`)
  return Boolean(spent)
}

/**
 * How long an unconfirmed authenticator secret can be confirmed, and with how
 * many wrong codes. `totp/setup` checks the password; `totp/confirm` asks only
 * for a session, so the pending secret carries that check forward and must not
 * outlive it: without these, a stolen session guesses codes against a setup
 * its owner abandoned, unhurried and uncounted, and turns 2FA on with a secret
 * the owner does not have.
 */
export const TOTP_SETUP_TTL_MINUTES = 15
export const MAX_TOTP_SETUP_ATTEMPTS = 5

/**
 * Spend one attempt at confirming this user's pending authenticator, before the
 * code is checked, like `claimLoginAttempt`. Only the session that ran setup,
 * within `TOTP_SETUP_TTL_MINUTES`, while attempts remain. Returns which attempt
 * this is, or `undefined` when there is nothing this session may confirm — and
 * then a pending secret that is expired or out of attempts is deleted, so it
 * does not linger. One from another, live session is left alone: deleting it
 * would let any session cancel the owner's setup.
 */
export async function claimTotpSetupAttempt(tx: Db, userId: string, sessionHash: string | undefined): Promise<number | undefined> {
  const [row] = await tx<{ attempts: number }[]>`
    UPDATE app.totp_credentials SET attempts = attempts + 1
    WHERE user_id = ${userId}
      AND confirmed_at IS NULL
      AND attempts < ${MAX_TOTP_SETUP_ATTEMPTS}
      AND created > now() - make_interval(mins => ${TOTP_SETUP_TTL_MINUTES})
      AND setup_session = (
        SELECT id FROM app.sessions
        WHERE token_hash = ${sessionHash ?? ''} AND user_id = ${userId} AND expires_at > now()
      )
    RETURNING attempts
  `
  if (row) return row.attempts

  await tx`
    DELETE FROM app.totp_credentials
    WHERE user_id = ${userId} AND confirmed_at IS NULL
      AND (attempts >= ${MAX_TOTP_SETUP_ATTEMPTS}
        OR created <= now() - make_interval(mins => ${TOTP_SETUP_TTL_MINUTES})
        OR setup_session IS NULL)
  `
  console.warn(`[mfa] authenticator setup for user ${userId} is unknown, expired, out of attempts or from another session`)
  return undefined
}

// ── recovery codes ─────────────────────────────────────────────────────────

/** Lower-case, no separators: what is hashed and what a typed code becomes. */
function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z2-7]/g, '')
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex')
}

/**
 * Replace this user's recovery codes with ten new ones, returned once. Twelve
 * base32 characters — 60 random bits — shown as `xxxx-xxxx-xxxx`.
 */
export async function mintRecoveryCodes(tx: Db, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(8)).slice(0, 12).toLowerCase()
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
  })
  await tx`DELETE FROM app.recovery_codes WHERE user_id = ${userId}`
  await tx`
    INSERT INTO app.recovery_codes ${tx(codes.map(code => ({ user_id: userId, code_hash: hashRecoveryCode(code) })))}
  `
  return codes
}

/** Spend one recovery code. Conditional on unused, so a code works exactly once. */
export async function consumeRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
  if (normaliseRecoveryCode(code).length !== 12) return false
  const [spent] = await db`
    UPDATE app.recovery_codes SET used_at = now()
    WHERE user_id = ${userId} AND code_hash = ${hashRecoveryCode(code)} AND used_at IS NULL
    RETURNING id
  `
  return Boolean(spent)
}

// ── enrolment bookkeeping ──────────────────────────────────────────────────

/**
 * Serialise factor changes for one user. Two enrolments racing must agree on
 * which one was "the first factor" — that one mints recovery codes — and a
 * removal racing an enrolment must not delete the codes the enrolment needs.
 */
export async function lockUserFactors(tx: Db, userId: string): Promise<void> {
  await tx`SELECT id FROM app.users WHERE id = ${userId} FOR UPDATE`
}

/**
 * After a factor is added, inside the same transaction: the first factor gets
 * recovery codes. Returns them (once), or `undefined` when the user already had
 * a factor and therefore already has codes.
 */
export async function afterFactorAdded(tx: Db, userId: string, hadFactor: boolean): Promise<string[] | undefined> {
  if (hadFactor) return undefined
  return await mintRecoveryCodes(tx, userId)
}

/** After a factor is removed: the last one takes its recovery codes with it. */
export async function afterFactorRemoved(tx: Db, userId: string): Promise<void> {
  if (hasSecondFactor(await userFactors(tx, userId))) return
  await tx`DELETE FROM app.recovery_codes WHERE user_id = ${userId}`
}

// ── throttle ───────────────────────────────────────────────────────────────

/**
 * A crude per-account throttle on second steps: ten attempts in fifteen minutes
 * and the next is refused for the rest of the window. Keys are `mfa:<user id>`.
 * The password step has its own, per email and per client address, in
 * `login-throttle.ts`.
 *
 * An attempt is counted when it is claimed, in the same synchronous step as the
 * check, so a burst arriving together cannot all pass before any is recorded.
 * A right answer hands its attempt back with `forgiveAuthAttempt`.
 *
 * In-memory and per-process, like the invitation mail throttle. A speed bump,
 * not a security control: a restart empties it and a second replica doubles
 * it. The per-challenge attempt cap is what bounds guessing a code.
 */
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const FAILURE_LIMIT = 10
const failures = new Map<string, number[]>()

function recentFailures(key: string, now: number): number[] {
  const recent = (failures.get(key) ?? []).filter(at => now - at < FAILURE_WINDOW_MS)
  if (recent.length) failures.set(key, recent)
  else failures.delete(key)
  return recent
}

/** Check and count an attempt, with no `await` between the two. Returns its timestamp. */
export function claimAuthAttempt(key: string): number {
  const now = Date.now()
  // Prune everything now and then so keys for addresses tried once do not pile up.
  if (failures.size > 10_000) for (const k of failures.keys()) recentFailures(k, now)
  const recent = recentFailures(key, now)
  if (recent.length >= FAILURE_LIMIT) {
    console.warn(`[mfa] throttled sign-in attempts for ${key.split(':')[0]}`)
    throw createError({ statusCode: 429, statusMessage: 'Too many failed attempts. Try again in a few minutes.' })
  }
  failures.set(key, [...recent, now])
  return now
}

/** The attempt claimed at `at` succeeded: it no longer counts against the account. */
export function forgiveAuthAttempt(key: string, at: number): void {
  dropAttempt(failures, key, at)
}

/**
 * Run `check` under an attempt claimed on `key` first, so a concurrent burst
 * counts. The attempt stays counted only when `isWrong` says the answer was
 * wrong; a right answer hands it back, and so does a throw — an outage (503) is
 * not a wrong guess.
 */
export async function withAuthAttempt<T>(key: string, check: () => Promise<T>, isWrong: (result: T) => boolean): Promise<T> {
  const claimedAt = claimAuthAttempt(key)
  let result: T
  try {
    result = await check()
  }
  catch (cause) {
    forgiveAuthAttempt(key, claimedAt)
    throw cause
  }
  if (!isWrong(result)) forgiveAuthAttempt(key, claimedAt)
  return result
}
