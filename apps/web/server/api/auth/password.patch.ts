import { z } from 'zod'

const body = z.object({
  currentPassword: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

/**
 * Change your own password.
 *
 * `passwordConfirm` is not a field: the "confirm new password" box is a typo
 * guard in the browser and never travels as its own field of truth. A server
 * that trusted a separately-submitted confirmation would be trusting the client
 * to have compared them.
 *
 * Every *other* session this user has is ended, so a session someone opened with
 * the old password does not outlive it; the one making the change stays signed
 * in. The address is told, best effort, in case it was not them.
 *
 * This revokes **no connector tokens**, and that is correct rather than an
 * oversight. They are minted by this app, stored only as hashes in `mcp_tokens`,
 * and have nothing to do with this password. A leaked connector token is
 * answered by rotating that token. The dialog says so, because "I changed my
 * password" otherwise reads as having closed every door.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { currentPassword, password } = await parseBody(event, body)

  await requireCurrentPassword(user, currentPassword)
  await setPassword(user.id, password)
  await endOtherSessions(event, user.id)
  notifyPasswordChanged(user.email, 'profile')

  // `reauthenticated` stays in the response for the client, which used to have
  // to re-sign-in after a credential change. The session is untouched now.
  return { ok: true, reauthenticated: true }
})
