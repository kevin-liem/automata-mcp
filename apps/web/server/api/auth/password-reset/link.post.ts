import { z } from 'zod'

const body = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

/**
 * Set a new password from the mailed link. Spent here, by the page's button,
 * never on page load. Signs nobody in: the page sends them to sign in, where a
 * second factor is asked for as usual.
 */
export default defineEventHandler(async (event) => {
  const { token, password } = await parseBody(event, body)
  const { email } = await resetPasswordByLink(event, token, password)
  return { ok: true, email }
})
