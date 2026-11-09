import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppUser, Db } from './app-db'
import { passwordChangedNoticeEmail, passwordResetEmail } from '../emails/account'

/**
 * Resetting a forgotten password, from a mailed link or code. Started by the
 * account's owner ("Forgot password?" on `/login`) or by an admin of their
 * organization (the Team page); finished only from the account's own inbox.
 *
 * A reset is a sign-in path, so it carries the rules every other one here has:
 *
 * - **No enumeration.** Asking answers the same whether or not the address has
 *   an account. An unknown address gets no mail — the form is not a way to mail
 *   any address from this deployment's domain — and the row write and the mail
 *   for a known one run after the answer, so neither the time taken nor a mail
 *   failure tells the two apart. A wrong code answers the same 400 whether the
 *   address has a reset, an account, or nothing.
 * - **The link is built from `NUXT_PUBLIC_APP_URL` only,** never from the
 *   request `Host`. Unset, the mail carries the code alone.
 * - **The link is spent only by POST,** never on page load: mail scanners open
 *   links. `link-info` names the account without spending it.
 * - **Single use, spent by `DELETE … RETURNING` inside the transaction that
 *   sets the password,** so two requests cannot both use one row, and a failure
 *   rolls the spend back. Thirty minutes. Wrong codes are claimed on the row
 *   before the answer is checked (five delete it) and capped per address and
 *   per client across rows (`assertResetCodeAllowed`).
 * - **The row is spent only while the account still signs in with the address
 *   it was mailed to.** A reset sitting in a mailbox the account has since moved
 *   away from is dead, whichever way the address changed.
 * - **A reset never signs anyone in.** It ends at "now sign in", so a second
 *   factor is asked for as usual and `startSession` is never reached from here.
 *   That also closes the forwarded-link trick verification has to guard
 *   against: a stranger resetting their own account and forwarding the link
 *   gets nobody signed in to it.
 * - **Every session of the account ends,** this browser's too, and half-finished
 *   sign-ins (`mfa_challenges` of purpose `login`) go with them: a session or a
 *   challenge someone opened with the old password must not outlive it.
 * - **Connector tokens are untouched.** They name connections, not credentials
 *   — the same reasoning as a DSN change. The notice mail says so.
 * - **No SMTP, no reset** (503 + log). The page says so; the operator's
 *   fallback is the database (`docs/self-hosting.md`).
 * - **A database fault is a 503,** never "no such account".
 *
 * An admin-started reset is the same row, TTL, caps and ending. The admin never
 * sees the link or the code and never sets the password: the mail goes only to
 * the member's stored address, nothing in the request becomes a recipient or
 * mail content, and it names the organization (not the admin) so an unexpected
 * reset is recognisable as one.
 */

const RESET_TTL_MS = 30 * 60 * 1000
const MAX_CODE_ATTEMPTS = 5

type ResetOrigin = 'self' | 'admin'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashCode(id: string, code: string): string {
  return sha256(`${id}:${code.trim()}`)
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function mintSecrets(id: string) {
  const linkToken = randomBytes(32).toString('base64url')
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  return { linkToken, code, linkHash: sha256(linkToken), codeHash: hashCode(id, code) }
}

/** The link in the mail; `NUXT_PUBLIC_APP_URL` only, the same reading as the mail's logo. */
function resetUrl(linkToken: string): string | undefined {
  const origin = emailBrand().appUrl
  return origin ? `${origin}/reset-password?token=${linkToken}` : undefined
}

/** Whether this deployment can reset passwords at all: it needs to send mail. */
export function passwordResetAvailable(): boolean {
  return Boolean(useRuntimeConfig().smtpHost)
}

/** Logged here because a handled 503 is invisible to Nitro. */
function assertResetDeliverable(): void {
  if (passwordResetAvailable()) return
  console.error('[password-reset] NUXT_SMTP_HOST is not set; refusing a password reset. Without mail the operator resets passwords in the database (docs/self-hosting.md).')
  throw createError({
    statusCode: 503,
    statusMessage: 'This deployment cannot send email, so passwords cannot be reset here. Ask an admin of your organization, or whoever runs this deployment.',
    data: { code: 'password_reset_unavailable' },
  })
}

// ── errors ─────────────────────────────────────────────────────────────────

export function resetLinkExpired(): Error {
  return createError({
    statusCode: 410,
    statusMessage: 'This reset link has expired or was already used. Ask for a new one.',
    data: { code: 'reset_expired' },
  })
}

/** One answer for every way a code can fail, so it says nothing about the address. */
function resetCodeInvalid(): Error {
  return createError({
    statusCode: 400,
    statusMessage: 'That code is not valid, or it has expired. Check the email address, or ask for a new code.',
    data: { code: 'reset_invalid' },
  })
}

// ── mail throttles ─────────────────────────────────────────────────────────

/**
 * Self-service: one mail per address per minute from one client, and a ceiling
 * per client per hour. Keyed on client *and* address, never the address alone,
 * or a stranger re-submitting someone's address once a minute keeps its owner
 * from ever getting a code. Counted whether or not the address has an account,
 * so a 429 says nothing either. In-memory and per-process, a speed bump like
 * the verification and invitation mail throttles.
 */
const ADDRESS_COOLDOWN_MS = 60_000
const IP_WINDOW_MS = 60 * 60 * 1000
const IP_LIMIT = 10

/**
 * Admin-started: one per member per five minutes, ten per admin per hour, so
 * the button cannot flood a colleague's inbox.
 */
const TARGET_COOLDOWN_MS = 5 * 60_000
const ADMIN_WINDOW_MS = 60 * 60 * 1000
const ADMIN_LIMIT = 10

const lastMailed = new Map<string, number>()
const windowed = new Map<string, number[]>()

function pruneThrottle(now: number): void {
  for (const [key, at] of lastMailed) {
    if (now - at >= Math.max(ADDRESS_COOLDOWN_MS, TARGET_COOLDOWN_MS)) lastMailed.delete(key)
  }
  for (const [key, times] of windowed) {
    const recent = times.filter(at => now - at < Math.max(IP_WINDOW_MS, ADMIN_WINDOW_MS))
    if (recent.length) windowed.set(key, recent)
    else windowed.delete(key)
  }
}

function recentCount(key: string, windowMs: number, now: number): number {
  return (windowed.get(key) ?? []).filter(at => now - at < windowMs).length
}

function cooling(key: string, cooldownMs: number, now: number): boolean {
  const at = lastMailed.get(key)
  return at !== undefined && now - at < cooldownMs
}

function claimMail(cooldownKey: string, windowKey: string, now: number): void {
  lastMailed.set(cooldownKey, now)
  windowed.set(windowKey, [...(windowed.get(windowKey) ?? []), now])
}

function claimSelfServiceMail(event: H3Event, email: string): void {
  const now = Date.now()
  pruneThrottle(now)
  const ip = clientIp(event)
  if (cooling(`self:${ip}:${email}`, ADDRESS_COOLDOWN_MS, now)) {
    throw createError({ statusCode: 429, statusMessage: 'A reset email was just requested for that address. Wait a minute before asking for another.' })
  }
  if (recentCount(`self-ip:${ip}`, IP_WINDOW_MS, now) >= IP_LIMIT) {
    throw createError({ statusCode: 429, statusMessage: 'Too many password reset requests. Try again later.' })
  }
  claimMail(`self:${ip}:${email}`, `self-ip:${ip}`, now)
}

function claimAdminMail(adminId: string, targetId: string): void {
  const now = Date.now()
  pruneThrottle(now)
  if (cooling(`admin-target:${targetId}`, TARGET_COOLDOWN_MS, now)) {
    throw createError({ statusCode: 429, statusMessage: 'A password reset was just sent to this member. Wait a few minutes before sending another.' })
  }
  if (recentCount(`admin:${adminId}`, ADMIN_WINDOW_MS, now) >= ADMIN_LIMIT) {
    throw createError({ statusCode: 429, statusMessage: 'Too many password reset emails sent in the last hour. Try again later.' })
  }
  claimMail(`admin-target:${targetId}`, `admin:${adminId}`, now)
}

// ── issuing ────────────────────────────────────────────────────────────────

/**
 * Write the reset row (replacing any earlier one for the account) and mail it.
 * Answers whether the mail went out; when it did not, the row is deleted again,
 * since a reset nobody received is only a live credential lying in the table.
 */
async function issueReset(user: Pick<AppUser, 'id' | 'email'>, origin: ResetOrigin, orgName?: string): Promise<boolean> {
  const sql = await appDb()
  const id = randomUUID()
  const secrets = mintSecrets(id)
  const expiresAt = new Date(Date.now() + RESET_TTL_MS)

  await sql.begin(async (tx) => {
    await tx`DELETE FROM app.password_resets WHERE expires_at < now()`
    // One pending reset per account: a new one makes the last mail dead.
    await tx`DELETE FROM app.password_resets WHERE user_id = ${user.id}`
    await tx`
      INSERT INTO app.password_resets ${tx({
        id,
        user_id: user.id,
        email: user.email,
        link_hash: secrets.linkHash,
        code_hash: secrets.codeHash,
        requested_by: origin,
        expires_at: expiresAt,
      })}
    `
  })

  const mail = passwordResetEmail({
    code: secrets.code,
    url: resetUrl(secrets.linkToken),
    expiresInMs: RESET_TTL_MS,
    ...(origin === 'admin' ? { requestedBy: { orgName: orgName ?? '' } } : {}),
  }, emailBrand())

  if (await sendAppEmail({ to: user.email, ...mail })) return true
  await sql`DELETE FROM app.password_resets WHERE id = ${id}`
  return false
}

/**
 * "Forgot password?". Answers nothing about the address: the account read runs
 * before the answer (so an outage is a 503, never "no such account"), and the
 * row write and the mail after it.
 */
export async function requestPasswordReset(event: H3Event, rawEmail: string): Promise<void> {
  assertResetDeliverable()
  const email = normaliseEmail(rawEmail)
  claimSelfServiceMail(event, email)

  let user: Pick<AppUser, 'id' | 'email'> | undefined
  try {
    const sql = await appDb()
    ;[user] = await sql<Pick<AppUser, 'id' | 'email'>[]>`SELECT id, email FROM app.users WHERE email = ${email}`
  }
  catch (cause) {
    console.error('[password-reset] could not read an account for a password reset:', cause)
    throw appDbUnavailable(cause)
  }
  if (!user) return

  const work = issueReset(user, 'self')
    .then((sent) => {
      if (!sent) console.error(`[password-reset] the reset mail for account ${user.id} did not go out; the reset was withdrawn.`)
    })
    .catch((cause: unknown) => {
      console.error(`[password-reset] could not issue a password reset for account ${user.id}:`, cause)
    })
  event.waitUntil?.(work)
}

/**
 * The Team page's button. The caller has checked the admin role and that the
 * target is in the admin's organization; this decides only whether to mail.
 * Answers whether the mail went out — the admin is told, since nothing about
 * the member's existence is secret from their own admin.
 */
export async function sendPasswordResetForMember(
  admin: Pick<AppUser, 'id'>,
  member: Pick<AppUser, 'id' | 'email'>,
  orgName: string,
): Promise<boolean> {
  assertResetDeliverable()
  claimAdminMail(admin.id, member.id)
  return await issueReset(member, 'admin', orgName)
}

// ── finishing ──────────────────────────────────────────────────────────────

interface ResetRow {
  id: string
  user_id: string
  email: string
  code_hash: string
  attempts: number
}

/**
 * The account a mailed link would reset, for the page to name before anyone
 * chooses a password. Holding the token is the authorization: the address is
 * the one the link was mailed to. Never spends it.
 */
export async function describeResetLink(token: string): Promise<{ email: string } | undefined> {
  try {
    const sql = await appDb()
    const [row] = await sql<{ email: string }[]>`
      SELECT r.email
      FROM app.password_resets r JOIN app.users u ON u.id = r.user_id AND u.email = r.email
      WHERE r.link_hash = ${sha256(token)} AND r.expires_at > now() AND r.attempts < ${MAX_CODE_ATTEMPTS}
    `
    return row
  }
  catch (cause) {
    console.error('[password-reset] could not read a reset link from the app database:', cause)
    throw appDbUnavailable(cause)
  }
}

/** The mailed link. */
export async function resetPasswordByLink(event: H3Event, token: string, password: string): Promise<{ email: string }> {
  // Read first, so a dead token costs a lookup rather than a scrypt hash.
  if (!await describeResetLink(token)) throw resetLinkExpired()
  const passwordHash = await hashPassword(password)
  return await finishReset(event, passwordHash, { linkHash: sha256(token) }, resetLinkExpired)
}

/**
 * The code, with the address it was mailed to. Works in any browser — an
 * admin-started reset has no waiting browser to bind it to, and a reset signs
 * nobody in, so binding would protect nothing. The guess budget is the row's
 * five attempts (claimed before the comparison, so a parallel burst counts)
 * under the per-address and per-client caps across rows.
 */
export async function resetPasswordByCode(event: H3Event, rawEmail: string, code: string, password: string): Promise<{ email: string }> {
  const email = normaliseEmail(rawEmail)
  // Before any read or write: a locked address must not burn its owner's row.
  assertResetCodeAllowed(event, email)

  const sql = await appDb()
  let row: ResetRow | undefined
  try {
    ;[row] = await sql<ResetRow[]>`
      UPDATE app.password_resets r SET attempts = r.attempts + 1
      FROM app.users u
      WHERE u.id = r.user_id AND u.email = ${email} AND r.email = u.email
        AND r.expires_at > now() AND r.attempts < ${MAX_CODE_ATTEMPTS}
      RETURNING r.id, r.user_id, r.email, r.code_hash, r.attempts
    `
  }
  catch (cause) {
    console.error('[password-reset] could not read a password reset from the app database:', cause)
    throw appDbUnavailable(cause)
  }

  if (!row || !sameHash(hashCode(row.id, code), row.code_hash)) {
    recordResetCodeFailure(event, email)
    if (row) {
      console.warn(`[password-reset] wrong reset code for account ${row.user_id} (${row.attempts} of ${MAX_CODE_ATTEMPTS})`)
      if (row.attempts >= MAX_CODE_ATTEMPTS) await sql`DELETE FROM app.password_resets WHERE id = ${row.id}`
    }
    throw resetCodeInvalid()
  }

  const passwordHash = await hashPassword(password)
  return await finishReset(event, passwordHash, { id: row.id }, resetCodeInvalid)
}

/**
 * Spend the row and set the password in one transaction: the delete is the
 * spend, so two requests using one reset find it once, and anything failing
 * after it puts the row back. Then every session and pending sign-in of the
 * account goes, and the address is told.
 */
async function finishReset(
  event: H3Event,
  passwordHash: string,
  match: { id: string } | { linkHash: string },
  gone: () => Error,
): Promise<{ email: string }> {
  const sql = await appDb()
  const user = await sql.begin(async (tx) => {
    const row = await spend(tx, match)
    if (!row) throw gone()

    const [updated] = await tx<Pick<AppUser, 'id' | 'email'>[]>`
      UPDATE app.users SET password_hash = ${passwordHash}, updated = now()
      WHERE id = ${row.user_id} AND email = ${row.email}
      RETURNING id, email
    `
    if (!updated) throw gone()

    await tx`DELETE FROM app.sessions WHERE user_id = ${updated.id}`
    await tx`DELETE FROM app.mfa_challenges WHERE user_id = ${updated.id} AND purpose = 'login'`
    return updated
  })

  console.info(`[password-reset] password reset for account ${user.id}`)
  // Locked out by wrong guesses is what sent many people here; the inbox is
  // proved now, so the per-email sign-in cap starts over.
  clearLoginFailures(user.email)
  // This browser's session went with the rest if it was this account's. One of
  // another account is left alone: an admin opening a member's forwarded link
  // must not be signed out of their own.
  if ((event.context.user as AppUser | undefined)?.id === user.id) clearSessionCookie(event)
  notifyPasswordChanged(user.email, 'reset')
  return { email: user.email }
}

/**
 * `DELETE … RETURNING`, joined to the account so the row is spent only while
 * the account still signs in with the address the mail went to.
 */
async function spend(tx: Db, match: { id: string } | { linkHash: string }): Promise<Pick<ResetRow, 'user_id' | 'email'> | undefined> {
  const [row] = 'id' in match
    ? await tx<Pick<ResetRow, 'user_id' | 'email'>[]>`
        DELETE FROM app.password_resets r USING app.users u
        WHERE r.id = ${match.id} AND u.id = r.user_id AND u.email = r.email
          AND r.expires_at > now() AND r.attempts <= ${MAX_CODE_ATTEMPTS}
        RETURNING r.user_id, r.email
      `
    : await tx<Pick<ResetRow, 'user_id' | 'email'>[]>`
        DELETE FROM app.password_resets r USING app.users u
        WHERE r.link_hash = ${match.linkHash} AND u.id = r.user_id AND u.email = r.email
          AND r.expires_at > now() AND r.attempts < ${MAX_CODE_ATTEMPTS}
        RETURNING r.user_id, r.email
      `
  return row
}

/**
 * Tell the account's address its password changed, best effort: after a reset,
 * and after a change on the profile page. In case it was not them.
 */
export function notifyPasswordChanged(email: string, how: 'reset' | 'profile'): void {
  const notice = passwordChangedNoticeEmail({ email, changedAt: new Date(), how }, emailBrand())
  void sendAppEmail({ to: email, ...notice })
}
