import { z } from 'zod'

const body = z.object({
  token: z.string().min(20).max(200),
})

/**
 * Which account a reset link is for, so the page names it before anyone
 * chooses a password. Never spends the link. A POST, like `link.post.ts`, so the
 * token stays out of access-log URLs.
 */
export default defineEventHandler(async (event) => {
  const { token } = await parseBody(event, body)
  const link = await describeResetLink(token)
  if (!link) throw resetLinkExpired()
  return link
})
