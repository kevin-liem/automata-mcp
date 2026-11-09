import { z } from 'zod'
import type { AppUser } from '~~/server/utils/app-db'

const body = z.object({
  email: z.string().email().max(200),
  currentPassword: z.string().min(1),
})

/**
 * Change your own email address.
 *
 * With email verification on (`server/utils/email-verification.ts`) the new
 * address gets a code and a link, and nothing changes until one comes back: an
 * account must not be able to take an address it does not own — someone else's
 * pending invitation included. The answer is `{ pending: true }` and the old
 * address keeps working meanwhile. The taken-address check still runs first,
 * so a signed-in user is told plainly rather than mailing the address's owner.
 *
 * With it off (no SMTP in `auto` mode, or `off`) the password proof is all
 * there is, as before: a change that waited on a mail this deployment cannot
 * send would leave the user waiting for a message nobody can deliver.
 *
 * The address is stored through `normaliseEmail()`, the same function invitation
 * acceptance compares against. Getting that wrong would make a pending
 * invitation for `Foo@Bar.com` unmatchable by an account that had just set its
 * address to exactly that.
 *
 * One consequence the person typing cannot see, so it is written down here: an
 * invitation addressed to their **old** address stops being redeemable by this
 * account, and one addressed to the **new** address starts being.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  assertEmailChangeAllowed()
  const { email, currentPassword } = await parseBody(event, body)

  await requireCurrentPassword(user, currentPassword)

  const next = normaliseEmail(email)
  if (next === normaliseEmail(user.email)) return { email: user.email, reauthenticated: true }

  if (emailVerificationRequired()) {
    if (verificationSetting() === 'required') assertVerificationDeliverable()
    const sql = await appDb()
    const [taken] = await sql`SELECT 1 FROM app.users WHERE email = ${next}`
    if (taken) throw createError({ statusCode: 409, statusMessage: 'That email address is already in use' })

    await startVerification(event, { purpose: 'email_change', email: next, userId: user.id })
    return { email: user.email, pending: true, pendingEmail: next, reauthenticated: true }
  }

  let updated: AppUser
  try {
    updated = await updateRow<AppUser>('users', user.id, { email: next })
  }
  catch (error) {
    // The body was valid; the world disagreed.
    if (isUniqueViolation(error)) {
      throw createError({ statusCode: 409, statusMessage: 'That email address is already in use' })
    }
    throw error
  }

  recordHostedEventQuietly({ type: 'user.email_changed', userId: user.id, payload: { from: user.email, to: updated.email } })
  return { email: updated.email, reauthenticated: true }
})
