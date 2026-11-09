import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { assertNever } from '#shared/connection'
import type { AppInvitation, AppUser, Db } from './app-db'

/**
 * Proving an address before it becomes someone's sign-in: at signup (with or
 * without an invitation) and when an account changes its address.
 *
 * **A signup has no `app.users` row until it is verified.** It waits in
 * `app.email_verifications`, which holds no unique claim on the address, so
 * several pending signups may name one address and the first to verify wins.
 * Without that, anyone could register `victim@company.com` before its owner
 * and keep it — the owner could neither sign up nor accept an invitation sent
 * there. Both signup invariants stay where they were: the account and its
 * organization (or its place in the inviting one) are still written in one
 * transaction, just later; and a row in `app.sessions` still means fully signed
 * in, because nothing creates one before the address is proved.
 *
 * An address change waits the same way: the old address keeps working until
 * the new one is proved.
 *
 * The mail carries a link and a six-digit code. The link stands alone (32
 * random bytes); the code works only with the `automata_verify` cookie the
 * waiting browser was handed, five wrong answers delete the row, and the row
 * expires after thirty minutes. Wrong codes are also capped per address across
 * every row (`assertVerifyCodeAllowed`), since a fresh signup is a fresh row
 * with five fresh guesses.
 *
 * **The link proves the address; it signs in only the browser that started
 * the signup.** A session starts when the confirming browser carries this
 * row's `automata_verify` cookie; any other browser gets "confirmed, now sign
 * in". Otherwise a stranger signs up with their own mailbox, forwards the
 * link, and whoever presses Confirm is signed into the stranger's organization
 * — where every connection they then set up lands.
 *
 * `NUXT_EMAIL_VERIFICATION` is `auto` (default: on when `NUXT_SMTP_HOST` is
 * set), `required` or `off`. Anything else reads as `required`, since a typo
 * must not switch verification off. `required` with no SMTP refuses signups
 * with a 503 rather than creating accounts nobody proved.
 */

export type VerificationSetting = 'auto' | 'required' | 'off'
export type VerificationPurpose = 'signup' | 'email_change'

export const VERIFY_COOKIE = 'automata_verify'
const VERIFY_COOKIE_PATH = '/api/auth/verify'

const VERIFICATION_TTL_MS = 30 * 60 * 1000
const MAX_CODE_ATTEMPTS = 5

interface VerificationRow {
  id: string
  purpose: VerificationPurpose
  email: string
  code_hash: string
  attempts: number
  user_id?: string
  password_hash?: string
  name?: string
  invite_id?: string
  first_account_only: boolean
  /** The plan picked on the signup page, in hosted mode. See cloud.ts. */
  plan?: 'free' | 'pro'
  /** The hosted signup page's marketing opt-in. Always false outside hosted mode. */
  marketing_consent: boolean
  expires_at: string
}

const ROW_COLUMNS = [
  'id', 'purpose', 'email', 'code_hash', 'attempts', 'user_id', 'password_hash', 'name',
  'invite_id', 'first_account_only', 'plan', 'marketing_consent', 'expires_at',
] as const

let warnedSetting = false

export function emailChangeDisabled(): boolean {
  return String(useRuntimeConfig().disableEmailChange).trim().toLowerCase() === 'true'
}

export function assertEmailChangeAllowed(): void {
  if (emailChangeDisabled()) {
    throw createError({ statusCode: 403, statusMessage: 'Email changes are disabled for this deployment' })
  }
}

export function verificationSetting(): VerificationSetting {
  const value = String(useRuntimeConfig().emailVerification ?? '').trim().toLowerCase()
  if (value === '' || value === 'auto') return 'auto'
  if (value === 'off' || value === 'required') return value
  if (!warnedSetting) {
    warnedSetting = true
    console.warn(`[verify] NUXT_EMAIL_VERIFICATION=${value} is not "auto", "required" or "off"; treating it as required.`)
  }
  return 'required'
}

function mailConfigured(): boolean {
  return Boolean(useRuntimeConfig().smtpHost)
}

/** Whether signups and address changes must prove the address first. */
export function emailVerificationRequired(): boolean {
  switch (verificationSetting()) {
    case 'off': return false
    case 'required': return true
    case 'auto': return mailConfigured()
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashCode(id: string, code: string): string {
  return sha256(`${id}:${code.trim()}`)
}

function codeMatches(row: Pick<VerificationRow, 'id' | 'code_hash'>, presented: string): boolean {
  const presentedHash = Buffer.from(hashCode(row.id, presented))
  const stored = Buffer.from(row.code_hash)
  return presentedHash.length === stored.length && timingSafeEqual(presentedHash, stored)
}

function mintSecrets(id: string) {
  const linkToken = randomBytes(32).toString('base64url')
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  return { linkToken, code, linkHash: sha256(linkToken), codeHash: hashCode(id, code) }
}

/**
 * The link in the mail. Built from `NUXT_PUBLIC_APP_URL` only, never from the
 * request: the `Host` header is the requester's to choose, and a link pointing
 * wherever they chose would hand them the token. Unset, the mail carries the
 * code alone.
 */
function verificationUrl(linkToken: string): string | undefined {
  const origin = String(useRuntimeConfig().public.appUrl ?? '').replace(/\/+$/, '')
  return origin ? `${origin}/verify-email?token=${linkToken}` : undefined
}

// ── errors ─────────────────────────────────────────────────────────────────

export function verificationExpired(): Error {
  return createError({
    statusCode: 410,
    statusMessage: 'This verification has expired or was already used. Start again.',
    data: { code: 'verification_expired' },
  })
}

function verificationUndeliverable(): Error {
  return createError({
    statusCode: 503,
    statusMessage: 'Could not send the verification email. Try again later, or ask the operator to check mail delivery.',
  })
}

/**
 * `required` with no SMTP: nothing can be proved, so nothing proceeds. Logged
 * here because a handled 503 is invisible to Nitro.
 */
export function assertVerificationDeliverable(): void {
  if (mailConfigured()) return
  console.error('[verify] NUXT_EMAIL_VERIFICATION=required but NUXT_SMTP_HOST is not set; refusing a signup or address change.')
  throw createError({
    statusCode: 503,
    statusMessage: 'This deployment requires email verification but cannot send email.',
  })
}

// ── throttle ───────────────────────────────────────────────────────────────

/**
 * A speed bump on verification mail: one per address per minute from one
 * client, and a ceiling per client per hour, so the signup form is not a way to
 * mail any address from this deployment's domain. In-memory and per-process,
 * like the invitation mail throttle.
 *
 * The cooldown is keyed on client *and* address, never the address alone:
 * otherwise a stranger re-submitting someone's address once a minute keeps its
 * owner from ever getting a code — the squatting this module exists to stop,
 * moved into the throttle.
 */
const ADDRESS_COOLDOWN_MS = 60_000
const IP_WINDOW_MS = 60 * 60 * 1000
const IP_LIMIT = 10

const lastMailed = new Map<string, number>()
const ipMailTimes = new Map<string, number[]>()

function pruneThrottle(now: number): void {
  for (const [key, at] of lastMailed) {
    if (now - at >= ADDRESS_COOLDOWN_MS) lastMailed.delete(key)
  }
  for (const [key, times] of ipMailTimes) {
    const recent = times.filter(at => now - at < IP_WINDOW_MS)
    if (recent.length) ipMailTimes.set(key, recent)
    else ipMailTimes.delete(key)
  }
}

function assertVerificationMailAllowed(event: H3Event, email: string): void {
  const now = Date.now()
  pruneThrottle(now)
  if (lastMailed.has(`${clientIp(event)}:${email}`)) {
    throw createError({
      statusCode: 429,
      statusMessage: 'A verification email was just sent to that address. Wait a minute before asking for another.',
    })
  }
  if ((ipMailTimes.get(clientIp(event))?.length ?? 0) >= IP_LIMIT) {
    throw createError({ statusCode: 429, statusMessage: 'Too many verification emails. Try again later.' })
  }
}

function recordVerificationMail(event: H3Event, email: string): void {
  const now = Date.now()
  const ip = clientIp(event)
  lastMailed.set(`${ip}:${email}`, now)
  ipMailTimes.set(ip, [...(ipMailTimes.get(ip) ?? []), now])
}

// ── mail ───────────────────────────────────────────────────────────────────

export function verificationMail(input: {
  purpose: VerificationPurpose
  code: string
  url?: string
  /** Signup for an address that already has an account: say so, carry no code. */
  alreadyRegistered?: boolean
}): { subject: string, text: string } {
  if (input.alreadyRegistered) {
    return {
      subject: 'You already have an account',
      text: [
        'Someone tried to create an account with this email address, which already has one.',
        '',
        'If that was you, sign in instead. If not, you can ignore this email — nothing was changed.',
      ].join('\n'),
    }
  }

  const what = input.purpose === 'signup' ? 'finish creating your account' : 'confirm your new sign-in address'
  return {
    subject: input.purpose === 'signup' ? 'Confirm your email address' : 'Confirm your new email address',
    text: [
      `Use this code to ${what}:`,
      '',
      `    ${input.code}`,
      '',
      ...(input.url ? ['Or open this link:', input.url, ''] : []),
      'The code and link expire in 30 minutes.',
      '',
      'If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  }
}

async function addressRegistered(db: Db, email: string): Promise<boolean> {
  const [row] = await db<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM app.users WHERE email = ${email}) AS exists`
  return Boolean(row?.exists)
}

/**
 * Mail one verification. A signup for an address that already has an account
 * gets a mail saying so instead of a code, and the caller answers exactly as it
 * would otherwise — so the signup form does not tell a stranger which addresses
 * are registered. An address change has no such case: the route refuses a
 * taken address before getting here, to an already signed-in user.
 */
async function mailVerification(
  event: H3Event,
  row: Pick<VerificationRow, 'purpose' | 'email'>,
  secrets: { code: string, linkToken: string },
): Promise<boolean> {
  const alreadyRegistered = row.purpose === 'signup' && await addressRegistered(await appDb(), row.email)
  const mail = verificationMail({
    purpose: row.purpose,
    code: secrets.code,
    url: verificationUrl(secrets.linkToken),
    alreadyRegistered,
  })
  recordVerificationMail(event, row.email)
  return sendAppEmail({ to: row.email, subject: mail.subject, text: mail.text })
}

// ── starting ───────────────────────────────────────────────────────────────

function setVerifyCookie(event: H3Event, token: string, expiresAt: Date): void {
  setCookie(event, VERIFY_COOKIE, token, { ...authCookieOptions(VERIFY_COOKIE_PATH), expires: expiresAt })
}

export function clearVerifyCookie(event: H3Event): void {
  setCookie(event, VERIFY_COOKIE, '', { ...authCookieOptions(VERIFY_COOKIE_PATH), maxAge: 0 })
}

type StartInput =
  | { purpose: 'signup', email: string, passwordHash: string, name: string, inviteId?: string, firstAccountOnly: boolean, plan?: 'free' | 'pro', marketingConsent: boolean }
  | { purpose: 'email_change', email: string, userId: string }

/**
 * Record a pending verification, hand this browser its cookie, mail the code.
 * When the mail does not go out the row is deleted and the request fails: a
 * pending signup nobody can finish is worse than an error saying so.
 */
export async function startVerification(event: H3Event, input: StartInput): Promise<{ email: string }> {
  const email = normaliseEmail(input.email)
  assertVerificationMailAllowed(event, email)

  const sql = await appDb()
  const id = randomUUID()
  const secrets = mintSecrets(id)
  const pendingToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS)

  await sql.begin(async (tx) => {
    await tx`DELETE FROM app.email_verifications WHERE expires_at < now()`
    // One pending change per account: asking again replaces the last one, so
    // an address typed by mistake stops being confirmable.
    if (input.purpose === 'email_change') {
      await tx`DELETE FROM app.email_verifications WHERE user_id = ${input.userId}`
    }
    await tx`
      INSERT INTO app.email_verifications ${tx({
        id,
        purpose: input.purpose,
        email,
        link_hash: secrets.linkHash,
        pending_hash: sha256(pendingToken),
        code_hash: secrets.codeHash,
        user_id: input.purpose === 'email_change' ? input.userId : null,
        password_hash: input.purpose === 'signup' ? input.passwordHash : null,
        name: input.purpose === 'signup' ? input.name : null,
        invite_id: input.purpose === 'signup' ? input.inviteId ?? null : null,
        first_account_only: input.purpose === 'signup' && input.firstAccountOnly,
        plan: input.purpose === 'signup' ? input.plan ?? null : null,
        marketing_consent: input.purpose === 'signup' && input.marketingConsent,
        expires_at: expiresAt,
      })}
    `
  })

  if (!await mailVerification(event, { purpose: input.purpose, email }, secrets)) {
    await sql`DELETE FROM app.email_verifications WHERE id = ${id}`
    throw verificationUndeliverable()
  }

  setVerifyCookie(event, pendingToken, expiresAt)
  return { email }
}

// ── reading and resending ──────────────────────────────────────────────────

/**
 * The verification this browser's cookie names, or `undefined`. Same failure
 * rule as `getSessionUser`: a database fault is a 503, never "nothing pending".
 */
export async function resolvePendingVerification(event: H3Event): Promise<VerificationRow | undefined> {
  const token = getCookie(event, VERIFY_COOKIE)
  if (!token) return undefined

  try {
    const sql = await appDb()
    const [row] = await sql<VerificationRow[]>`
      SELECT ${sql(ROW_COLUMNS)}
      FROM app.email_verifications
      WHERE pending_hash = ${sha256(token)}
        AND expires_at > now()
        AND attempts < ${MAX_CODE_ATTEMPTS}
    `
    if (row?.purpose === 'email_change' && emailChangeDisabled()) return undefined
    return row
  }
  catch (cause) {
    console.error('[verify] could not read a pending verification from the app database:', cause)
    throw appDbUnavailable(cause)
  }
}

/** The pending address change for an account, for the profile page. */
export async function pendingEmailChange(userId: string): Promise<string | undefined> {
  const sql = await appDb()
  const [row] = await sql<{ email: string }[]>`
    SELECT email FROM app.email_verifications
    WHERE user_id = ${userId} AND purpose = 'email_change'
      AND expires_at > now() AND attempts < ${MAX_CODE_ATTEMPTS}
  `
  return row?.email
}

export async function cancelEmailChange(event: H3Event, userId: string): Promise<void> {
  const sql = await appDb()
  await sql`DELETE FROM app.email_verifications WHERE user_id = ${userId} AND purpose = 'email_change'`
  clearVerifyCookie(event)
}

/**
 * Mail a fresh code and link for the pending verification. The old ones stop
 * working. Neither the expiry nor the attempt count resets: resending is for a
 * mail that did not arrive, not a way to buy more guesses or more time.
 */
export async function resendVerification(event: H3Event): Promise<{ email: string }> {
  const row = await resolvePendingVerification(event)
  if (!row) throw verificationExpired()
  assertVerificationMailAllowed(event, row.email)

  const sql = await appDb()
  const secrets = mintSecrets(row.id)
  const [updated] = await sql`
    UPDATE app.email_verifications SET link_hash = ${secrets.linkHash}, code_hash = ${secrets.codeHash}
    WHERE id = ${row.id} AND expires_at > now()
    RETURNING id
  `
  if (!updated) throw verificationExpired()

  if (!await mailVerification(event, row, secrets)) throw verificationUndeliverable()
  return { email: row.email }
}

// ── completing ─────────────────────────────────────────────────────────────

export interface VerificationResult {
  purpose: VerificationPurpose
  email: string
  /** Whether this request was signed in. False for a signup confirmed by link in another browser. */
  signedIn: boolean
  /**
   * `checkout` when the signup picked Pro and this browser is signed in: the
   * page sends it on to Stripe. Anywhere else, the trial waits on the Billing
   * page — the organization is on Free until Stripe confirms either way.
   */
  next?: 'checkout'
}

/** A spent row, with the hash that says which browser was waiting for it. */
type SpentRow = VerificationRow & { pending_hash: string }

const SPENT_COLUMNS = [...ROW_COLUMNS, 'pending_hash'] as const

/** Whether this request carries the `automata_verify` cookie the row was started with. */
function isWaitingBrowser(event: H3Event, row: Pick<SpentRow, 'pending_hash'>): boolean {
  const token = getCookie(event, VERIFY_COOKIE)
  if (!token) return false
  const presented = Buffer.from(sha256(token))
  const stored = Buffer.from(row.pending_hash)
  return presented.length === stored.length && timingSafeEqual(presented, stored)
}

/** The code typed into the waiting browser. */
export async function verifyByCode(event: H3Event, code: string): Promise<VerificationResult> {
  const row = await resolvePendingVerification(event)
  if (!row) {
    clearVerifyCookie(event)
    throw verificationExpired()
  }

  // Before the comparison, and before any write: a locked address must not
  // burn its owner's row either.
  assertVerifyCodeAllowed(event, row.email)

  if (!codeMatches(row, code)) {
    console.warn(`[verify] wrong verification code for a pending ${row.purpose}`)
    recordVerifyCodeFailure(row.email)
    const sql = await appDb()
    // Conditional, so two wrong answers in flight cannot both be the fourth.
    const [counted] = await sql<{ attempts: number }[]>`
      UPDATE app.email_verifications SET attempts = attempts + 1
      WHERE id = ${row.id} AND attempts < ${MAX_CODE_ATTEMPTS}
      RETURNING attempts
    `
    if (!counted || counted.attempts >= MAX_CODE_ATTEMPTS) {
      await sql`DELETE FROM app.email_verifications WHERE id = ${row.id}`
      clearVerifyCookie(event)
      throw verificationExpired()
    }
    throw createError({ statusCode: 400, statusMessage: 'That code is not valid', data: { code: 'verification_invalid' } })
  }

  // Found through the cookie, so this is the waiting browser by construction.
  return await complete(event, tx => spend(tx, { id: row.id }), () => true)
}

/**
 * The link from the mail. Needs no cookie to prove the address — the token is
 * the proof — but signs in only the browser holding this row's cookie.
 */
export async function verifyByLink(event: H3Event, token: string): Promise<VerificationResult> {
  return await complete(event, tx => spend(tx, { linkHash: sha256(token) }), row => isWaitingBrowser(event, row))
}

/**
 * What a mailed link would confirm, for the Confirm screen, without spending
 * it. Holding the token is the authorization: the address is the one it was
 * mailed to.
 */
export async function describeVerificationLink(token: string): Promise<{ purpose: VerificationPurpose, email: string } | undefined> {
  try {
    const sql = await appDb()
    const [row] = await sql<Pick<VerificationRow, 'purpose' | 'email'>[]>`
      SELECT purpose, email
      FROM app.email_verifications
      WHERE link_hash = ${sha256(token)}
        AND expires_at > now()
        AND attempts < ${MAX_CODE_ATTEMPTS}
    `
    if (row?.purpose === 'email_change' && emailChangeDisabled()) return undefined
    return row ? { purpose: row.purpose, email: row.email } : undefined
  }
  catch (cause) {
    console.error('[verify] could not read a verification link from the app database:', cause)
    throw appDbUnavailable(cause)
  }
}

/**
 * Delete the row and return it, inside the transaction that acts on it. The
 * delete is the spend: two requests verifying one row at once find it once,
 * and a failure further on rolls the spend back with everything else.
 */
async function spend(tx: Db, match: { id: string } | { linkHash: string }): Promise<SpentRow | undefined> {
  const [row] = 'id' in match
    ? await tx<SpentRow[]>`
        DELETE FROM app.email_verifications
        WHERE id = ${match.id} AND expires_at > now() AND attempts < ${MAX_CODE_ATTEMPTS}
        RETURNING ${tx(SPENT_COLUMNS)}
      `
    : await tx<SpentRow[]>`
        DELETE FROM app.email_verifications
        WHERE link_hash = ${match.linkHash} AND expires_at > now() AND attempts < ${MAX_CODE_ATTEMPTS}
        RETURNING ${tx(SPENT_COLUMNS)}
      `
  return row
}

/**
 * `waitingBrowser` decides whether the request is the browser that started the
 * row. Only that one is signed in, and only its cookie is cleared — a link
 * confirmed elsewhere must not wipe a different pending signup in this browser.
 */
async function complete(
  event: H3Event,
  spendIn: (tx: Db) => Promise<SpentRow | undefined>,
  waitingBrowser: (row: SpentRow) => boolean,
): Promise<VerificationResult> {
  const sql = await appDb()
  let spentId: string | undefined
  let ownsCookie = false

  let outcome: { row: VerificationRow, userId?: string, previousEmail?: string }
  try {
    outcome = await sql.begin(async (tx) => {
      const row = await spendIn(tx)
      if (!row) throw verificationExpired()
      spentId = row.id
      ownsCookie = waitingBrowser(row)

      switch (row.purpose) {
        case 'signup':
          return { row, userId: await createVerifiedAccount(tx, row) }
        case 'email_change':
          return { row, previousEmail: await changeVerifiedEmail(tx, row) }
        default:
          return assertNever(row.purpose)
      }
    })
  }
  catch (error) {
    // Refused for good (address taken meanwhile, invitation revoked): the row
    // can never succeed, so it goes rather than waiting out its expiry.
    const status = (error as { statusCode?: number }).statusCode
    if (spentId && status && status < 500 && status !== 410) {
      await sql`DELETE FROM app.email_verifications WHERE id = ${spentId}`.catch(() => {})
      if (ownsCookie) clearVerifyCookie(event)
    }
    throw error
  }

  if (ownsCookie) clearVerifyCookie(event)
  const { row, userId, previousEmail } = outcome

  const signedIn = Boolean(userId) && ownsCookie
  if (signedIn) await startSession(event, userId!)
  if (previousEmail) {
    // Best effort: tells the owner of the old address, in case it was not them.
    void sendAppEmail({
      to: previousEmail,
      subject: 'Your sign-in email address was changed',
      text: [
        `The sign-in address of your account was changed from ${previousEmail} to ${row.email}.`,
        '',
        'If you did not do this, contact an admin of your organization.',
      ].join('\n'),
    })
  }

  const next = signedIn && row.plan === 'pro' && !row.invite_id && hostedMode() ? 'checkout' as const : undefined
  return { purpose: row.purpose, email: row.email, signedIn, ...(next ? { next } : {}) }
}

/**
 * The signup, as `signup.post.ts` would have written it without verification:
 * account and organization (or its place in the inviting one) together. The
 * invitation is re-read, since it may have been revoked while the mail was in
 * flight; `markInviteAccepted` is conditional either way.
 */
async function createVerifiedAccount(tx: Db, row: VerificationRow): Promise<string> {
  if (row.first_account_only) await claimFirstAccount(tx)

  // Re-checked here, not only at signup: a row written in hosted mode is
  // verified by whatever the deployment is now.
  const marketingConsent = row.marketing_consent && hostedMode()
  const created = await createUser(tx, { email: row.email, passwordHash: row.password_hash!, name: row.name ?? '', marketingConsent })
  await recordHostedEvent(tx, {
    type: 'user.signed_up',
    userId: created.id,
    payload: { email: created.email, name: created.name, plan: row.plan ?? null, invited: Boolean(row.invite_id), marketingConsent },
  })

  if (row.invite_id) {
    const [invite] = await tx<AppInvitation[]>`SELECT * FROM app.invitations WHERE id = ${row.invite_id}`
    const problem = invite ? inviteProblemOf(invite) : 'not-found'
    if (problem || !invite) {
      throw createError({ statusCode: problem === 'not-found' ? 404 : 422, statusMessage: inviteProblemMessage(problem ?? 'not-found') })
    }
    await acceptInviteInto(tx, created, invite.org, invite.role)
    await markInviteAccepted(tx, invite.id, created.id)
  }
  else {
    await createOrganizationFor(tx, created)
  }
  return created.id
}

/** Returns the address being replaced. */
async function changeVerifiedEmail(tx: Db, row: VerificationRow): Promise<string> {
  // A verification link may have been issued before the lock was enabled.
  assertEmailChangeAllowed()
  const [current] = await tx<Pick<AppUser, 'email'>[]>`
    SELECT email FROM app.users WHERE id = ${row.user_id!} FOR UPDATE
  `
  if (!current) throw verificationExpired()

  try {
    await tx`UPDATE app.users SET email = ${row.email}, updated = now() WHERE id = ${row.user_id!}`
    await recordHostedEvent(tx, { type: 'user.email_changed', userId: row.user_id!, payload: { from: current.email, to: row.email } })
  }
  catch (error) {
    if (isUniqueViolation(error)) {
      throw createError({ statusCode: 409, statusMessage: 'That email address is already in use' })
    }
    throw error
  }
  return current.email
}
