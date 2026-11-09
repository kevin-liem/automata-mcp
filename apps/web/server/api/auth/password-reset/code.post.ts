import { z } from 'zod'

const body = z.object({
  email: z.string().email().max(200),
  code: z.string().min(1).max(20),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

/**
 * Set a new password with the mailed code and the address it went to. Every
 * failure is the same 400, whether or not the address has an account or a
 * reset. Signs nobody in.
 */
export default defineEventHandler(async (event) => {
  const { email, code, password } = await parseBody(event, body)
  const result = await resetPasswordByCode(event, email, code, password)
  return { ok: true, email: result.email }
})
