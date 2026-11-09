import { z } from 'zod'

const body = z.object({ code: z.string().trim().min(1).max(20) })

/**
 * Finish adding an authenticator app with a code from it.
 *
 * Asks only for a session, so the password typed at `totp/setup` is what
 * authorises this, and the pending secret is held to it: only the session that
 * ran setup may confirm, within `TOTP_SETUP_TTL_MINUTES`, with
 * `MAX_TOTP_SETUP_ATTEMPTS` codes — each claimed before it is checked, the last
 * wrong one deleting the secret. Past any of those, setup starts again, with
 * the password.
 *
 * If this is the account's first factor, two more things happen: ten recovery
 * codes are minted and returned (the only time they are shown), and every
 * other session ends — one opened before 2FA was on must not keep the access
 * 2FA was turned on to deny.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { code } = await parseBody(event, body)
  const sql = await appDb()

  const result = await withAuthAttempt(`totp-setup:${user.id}`, () => sql.begin(async (tx) => {
    await lockUserFactors(tx, user.id)
    const attempt = await claimTotpSetupAttempt(tx, user.id, currentSessionHash(event))
    if (attempt === undefined) return { refused: 'expired' as const }

    const hadFactor = hasSecondFactor(await userFactors(tx, user.id))
    if (!await consumeTotpCode(tx, user.id, code.replace(/\s/g, ''), false)) {
      if (attempt < MAX_TOTP_SETUP_ATTEMPTS) return { refused: 'wrong' as const, left: MAX_TOTP_SETUP_ATTEMPTS - attempt }
      await tx`DELETE FROM app.totp_credentials WHERE user_id = ${user.id} AND confirmed_at IS NULL`
      return { refused: 'expired' as const }
    }
    await tx`UPDATE app.totp_credentials SET confirmed_at = now(), setup_session = NULL WHERE user_id = ${user.id}`

    return { hadFactor, recoveryCodes: await afterFactorAdded(tx, user.id, hadFactor) }
  }), result => 'refused' in result)

  if ('refused' in result) {
    if (result.refused === 'wrong') {
      throw createError({
        statusCode: 400,
        statusMessage: `That code does not match. Check the time on your phone and try the next one (${result.left} ${result.left === 1 ? 'try' : 'tries'} left).`,
      })
    }
    throw createError({
      statusCode: 410,
      statusMessage: 'This setup is no longer valid: too many wrong codes, too old, or started in another browser. Start again with your password.',
      data: { code: 'totp_setup_expired' },
    })
  }
  if (!result.hadFactor) await endOtherSessions(event, user.id)
  return { recoveryCodes: result.recoveryCodes }
})
