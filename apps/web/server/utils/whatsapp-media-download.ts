import type { McpAuth } from './mcp-auth'
import { MEDIA_DOWNLOAD_TTL_MS, signMediaDownloadGrant } from './media-download-grant'

/** Stateless across replicas: the URL can re-fetch only this exact attachment. */
export async function createWhatsAppMediaDownload(auth: McpAuth, jid: string, messageId: string, sha256: string) {
  const base = useRuntimeConfig().public.appUrl
  if (!base) throw createError({ statusCode: 503, message: 'Set NUXT_PUBLIC_APP_URL to the public app URL to enable media download links.' })
  let publicUrl: URL
  try { publicUrl = new URL(base) }
  catch { throw createError({ statusCode: 503, message: 'NUXT_PUBLIC_APP_URL must be a valid public app URL.' }) }
  if (publicUrl.username || publicUrl.password) {
    throw createError({ statusCode: 503, message: 'NUXT_PUBLIC_APP_URL must not contain credentials.' })
  }
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname))) {
    throw createError({ statusCode: 503, message: 'NUXT_PUBLIC_APP_URL must use HTTPS for media download links.' })
  }
  const sql = await appDb()
  const [token] = await sql<{ token_hash: string }[]>`
    SELECT token_hash FROM app.mcp_tokens
    WHERE id = ${auth.tokenId} AND token_hash = ${auth.credentialHash}
      AND revoked = false AND (expires_at IS NULL OR expires_at > now())
  `
  if (!token) throw createError({ statusCode: 401, message: 'The connector token is no longer active.' })
  const expiresAt = Date.now() + MEDIA_DOWNLOAD_TTL_MS
  const grant = signMediaDownloadGrant({ tokenId: auth.tokenId, jid, messageId, sha256, expiresAt }, token.token_hash)
  return {
    downloadUrl: new URL(`/api/media/whatsapp/${grant}`, publicUrl).href,
    downloadExpiresAt: new Date(expiresAt).toISOString(),
  }
}
