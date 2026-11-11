import { createHash } from 'node:crypto'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    setHeader(event, 'Allow', 'GET, HEAD')
    throw createError({ statusCode: 405, message: 'Media download links support GET and HEAD only.' })
  }
  const access = await resolveMediaDownloadAuth(getRouterParam(event, 'grant') ?? '')
  if (!access) throw createError({ statusCode: 404, message: 'This media link is invalid or expired. Retrieve the attachment again to get a new link.' })
  const { auth, grant } = access
  event.context.mcpAuth = auth
  if (!isToolAllowed(event, 'get-whatsapp-media', 'whatsapp')) {
    throw createError({ statusCode: 403, message: 'This connector token can no longer retrieve WhatsApp media.' })
  }
  const refusal = await mcpLimitRefusal(auth.instance.org, auth.tokenId, auth.limits)
  if (refusal) return refusal
  const file = await fetchWhatsAppMedia(auth, grant.jid, grant.messageId)
  if (createHash('sha256').update(file.data).digest('hex') !== grant.sha256) {
    throw createError({ statusCode: 409, message: 'The attachment changed. Retrieve it again to get a new download link.' })
  }
  const filename = Array.from(file.filename.toWellFormed().replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 180).join('') || 'attachment'
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(file.mimeType) ? file.mimeType : 'application/octet-stream'
  setHeader(event, 'Content-Type', mimeType)
  setHeader(event, 'Content-Length', file.data.length)
  setHeader(event, 'Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encoded}`)
  return send(event, file.data)
})
