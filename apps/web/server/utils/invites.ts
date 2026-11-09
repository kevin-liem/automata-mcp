import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInvitation, AppUser, Db, OrgRole } from './app-db'
import type { Actor } from './org'
import { invitationEmail } from '../emails/account'

/**
 * Organization invitations.
 *
 * Link/code based: an admin creates an invitation for an email address, the app
 * returns a one-time URL, and the admin either copies it or has it emailed to
 * that address. The code is therefore a **bearer credential for joining an
 * organization**, and gets the same handling as an MCP token — 32 random bytes,
 * shown exactly once, stored only as a SHA-256 hash, compared in constant time.
 * Email is an additional delivery, never a replacement for showing the link:
 * mail can fail, and a link nobody saw is an invitation nobody can accept.
 *
 * A bearer credential alone is not enough to join. Every invitation names an
 * email address and acceptance requires the accepting account's own email to
 * match, so a link that leaks into a group chat cannot be redeemed by whoever
 * happens to read it first.
 */

const CODE_PREFIX = 'waorg_'

/** Fourteen days. Long enough to survive a weekend and a forwarded message. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface InviteView {
  id: string
  email: string
  role: OrgRole
  created?: string
  expires_at?: string
  expired: boolean
  invited_by?: string
}

/** Mint a code. The plaintext is returned once and never stored. */
export function mintInviteCode(): { code: string, hash: string } {
  const code = CODE_PREFIX + randomBytes(32).toString('base64url')
  return { code, hash: hashInviteCode(code) }
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function inviteExpiry(): string {
  return new Date(Date.now() + INVITE_TTL_MS).toISOString()
}

/** Emails are stored and compared lower-cased and trimmed. `app.users` enforces it with a CHECK. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

function isExpired(invite: Pick<AppInvitation, 'expires_at'>): boolean {
  return Boolean(invite.expires_at) && new Date(invite.expires_at!).getTime() <= Date.now()
}

/** What an admin may see about an invitation. Never the code or its hash. */
export function toInviteView(invite: AppInvitation): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    created: invite.created,
    expires_at: invite.expires_at || undefined,
    expired: isExpired(invite),
    invited_by: invite.invited_by || undefined,
  }
}

/** Pending means: not revoked, not accepted, not expired. */
export async function listPendingInvites(orgId: string): Promise<InviteView[]> {
  const sql = await appDb()
  const rows = await sql<AppInvitation[]>`
    SELECT * FROM app.invitations
    WHERE org = ${orgId} AND NOT revoked AND accepted_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created DESC
  `
  return rows.map(toInviteView)
}

/**
 * Create an invitation, replacing any pending one for the same address.
 *
 * "One pending invitation per (org, email)" is enforced here, in one
 * transaction with the insert. Superseding rather than refusing is the kinder
 * behaviour — an admin re-inviting someone almost always means "the last link
 * got lost", and the old code stops working the moment the new one is made.
 */
export async function createInvite(
  orgId: string,
  invitedBy: AppUser,
  email: string,
  role: OrgRole,
): Promise<{ code: string, invite: InviteView }> {
  const sql = await appDb()
  const address = normaliseEmail(email)
  const { code, hash } = mintInviteCode()

  const invite = await sql.begin(async (tx) => {
    await tx`
      UPDATE app.invitations SET revoked = true, updated = now()
      WHERE org = ${orgId} AND email = ${address} AND NOT revoked AND accepted_at IS NULL
    `
    const [row] = await tx<AppInvitation[]>`
      INSERT INTO app.invitations (org, email, role, code_hash, invited_by, expires_at)
      VALUES (${orgId}, ${address}, ${role}, ${hash}, ${invitedBy.id}, ${inviteExpiry()})
      RETURNING *
    `
    return row!
  })

  return { code, invite: toInviteView(invite) }
}

/** Why an invitation cannot be used. `undefined` means it can. */
export type InviteProblem = 'not-found' | 'revoked' | 'expired' | 'accepted'

/**
 * Resolve a presented code to its invitation.
 *
 * Returns the row even when it is unusable, with the reason, so the caller can
 * say *why* rather than "no such invitation". That is deliberately more
 * informative than the equivalent MCP token path: whoever holds the code already
 * knows it existed, so distinguishing "expired" from "never existed" leaks
 * nothing and saves a support round-trip.
 *
 * A lookup miss is `not-found`; a backend fault throws.
 */
export async function resolveInvite(
  code: string,
): Promise<{ invite?: AppInvitation, problem?: InviteProblem }> {
  if (!code || !code.startsWith(CODE_PREFIX)) return { problem: 'not-found' }

  const sql = await appDb()
  const hash = hashInviteCode(code)

  const [invite] = await sql<AppInvitation[]>`SELECT * FROM app.invitations WHERE code_hash = ${hash}`
  if (!invite) return { problem: 'not-found' }

  // Defence in depth: the lookup already proves equality, but compare explicitly
  // so a future change to the query cannot weaken this.
  const presented = Buffer.from(hash)
  const stored = Buffer.from(invite.code_hash)
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return { problem: 'not-found' }
  }

  return { invite, problem: inviteProblemOf(invite) }
}

/** Why a loaded invitation cannot be used, or `undefined` when it can. */
export function inviteProblemOf(invite: AppInvitation): InviteProblem | undefined {
  if (invite.revoked) return 'revoked'
  if (invite.accepted_at) return 'accepted'
  if (isExpired(invite)) return 'expired'
  return undefined
}

/** The message for an unusable invitation, written for the person holding it. */
export function inviteProblemMessage(problem: InviteProblem): string {
  switch (problem) {
    case 'revoked':
      return 'This invitation has been revoked. Ask for a new link.'
    case 'expired':
      return 'This invitation has expired. Ask for a new link.'
    case 'accepted':
      return 'This invitation has already been used.'
    default:
      return 'This invitation link is not valid.'
  }
}

/**
 * The link that redeems a code. One definition for create, email and resend, so
 * the link shown on screen and the link in the mail cannot differ.
 */
export function inviteUrl(event: H3Event, code: string): string {
  const origin = useRuntimeConfig().public.appUrl || getRequestURL(event).origin
  return `${origin.replace(/\/+$/, '')}/invite/${code}`
}

/**
 * A crude throttle on invitation mail.
 *
 * Every signup makes its author an admin of a fresh organization, so without
 * this the invite form is a way for anyone to mail any address from this
 * deployment's domain, with an organization name of their choosing in the
 * subject. Two limits: one mail per address per organization per minute (keyed
 * on the address, not the invitation id, because a resend mints a new id each
 * time), and a ceiling per organization per hour.
 *
 * In-memory and per-process, like the webhook cooldown. It is a speed bump, not
 * a security control: a restart empties it and a second replica doubles it.
 */
const INVITE_MAIL_COOLDOWN_MS = 60_000
const ORG_MAIL_WINDOW_MS = 60 * 60 * 1000
const ORG_MAIL_LIMIT = 20

const lastMailedAddress = new Map<string, number>()
const orgMailTimes = new Map<string, number[]>()

function pruneMailThrottle(now: number): void {
  for (const [key, at] of lastMailedAddress) {
    if (now - at >= INVITE_MAIL_COOLDOWN_MS) lastMailedAddress.delete(key)
  }
  for (const [org, times] of orgMailTimes) {
    const recent = times.filter(at => now - at < ORG_MAIL_WINDOW_MS)
    if (recent.length) orgMailTimes.set(org, recent)
    else orgMailTimes.delete(org)
  }
}

/** Throws 429 if this organization may not send invitation mail right now. */
export function assertInviteMailAllowed(orgId: string, email: string): void {
  const now = Date.now()
  pruneMailThrottle(now)

  if (lastMailedAddress.has(`${orgId}:${normaliseEmail(email)}`)) {
    throw createError({
      statusCode: 429,
      statusMessage: 'An invitation was just emailed to that address. Wait a minute before sending another.',
    })
  }
  if ((orgMailTimes.get(orgId)?.length ?? 0) >= ORG_MAIL_LIMIT) {
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many invitation emails from this organization in the last hour. Copy the link instead, or try again later.',
    })
  }
}

function recordInviteMail(orgId: string, email: string): void {
  const now = Date.now()
  lastMailedAddress.set(`${orgId}:${normaliseEmail(email)}`, now)
  orgMailTimes.set(orgId, [...(orgMailTimes.get(orgId) ?? []), now])
}

/**
 * Email an invitation's link to the address stored on it. Answers whether the
 * mail went out; `sendAppEmail` logs the cause when it did not.
 *
 * The recipient is always the invitation's own address, never one taken from a
 * request. Call `assertInviteMailAllowed` first — separately, because a resend
 * must be refused before it supersedes the old link, not after.
 */
export async function sendInviteEmail(
  event: H3Event,
  actor: Actor,
  invite: Pick<AppInvitation, 'email' | 'role'>,
  code: string,
): Promise<boolean> {
  recordInviteMail(actor.org.id, invite.email)

  const mail = invitationEmail({
    inviterName: actor.user.name?.trim() || actor.user.email,
    orgName: actor.org.name,
    role: invite.role,
    email: invite.email,
    url: inviteUrl(event, code),
    expiresInMs: INVITE_TTL_MS,
  }, emailBrand())

  return sendAppEmail({ to: invite.email, ...mail })
}

/**
 * Spend an invitation, inside the transaction that acts on it. Conditional on
 * it still being usable, so two acceptances racing on one code cannot both
 * succeed: the second finds nothing to update and its transaction rolls back.
 */
export async function markInviteAccepted(tx: Db, inviteId: string, userId: string): Promise<void> {
  const result = await tx`
    UPDATE app.invitations SET accepted_at = now(), accepted_by = ${userId}, updated = now()
    WHERE id = ${inviteId} AND accepted_at IS NULL AND NOT revoked
  `
  if (!result.count) {
    throw createError({ statusCode: 409, statusMessage: inviteProblemMessage('accepted') })
  }
}
