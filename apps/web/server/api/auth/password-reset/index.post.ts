import { z } from 'zod'

const body = z.object({
  email: z.string().email().max(200),
})

/**
 * "Forgot password?": mail a reset code and link to the address, if it has an
 * account. The answer is the same either way — see `password-reset.ts` for how
 * neither the time taken nor a failed mail gives that away. No SMTP is a 503
 * before anything else, which says nothing about any address.
 */
export default defineEventHandler(async (event) => {
  const { email } = await parseBody(event, body)
  await requestPasswordReset(event, email)
  return { ok: true, email: normaliseEmail(email) }
})
