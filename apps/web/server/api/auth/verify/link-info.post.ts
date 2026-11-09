import { z } from 'zod'

const body = z.object({
  token: z.string().min(20).max(200),
})

/**
 * What a verification link would confirm, so the Confirm screen can name the
 * address — and, for an invited signup, the organization and role — before
 * anyone presses it, and say up front when this browser cannot finish it.
 * Never spends the link. A POST, like `link.post.ts`, so the token stays out
 * of access-log URLs.
 */
export default defineEventHandler(async (event) => {
  const { token } = await parseBody(event, body)
  const link = await describeVerificationLink(event, token)
  if (!link) throw verificationExpired()
  return link
})
