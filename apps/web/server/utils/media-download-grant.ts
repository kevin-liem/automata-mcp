import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const MEDIA_DOWNLOAD_TTL_MS = 5 * 60 * 1000

const grantSchema = z.object({
  tokenId: z.string().min(1).max(256),
  jid: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
}).strict()

export type MediaDownloadGrant = z.infer<typeof grantSchema>

/** One file only. No original MCP bearer token is included in the URL. */
export function signMediaDownloadGrant(grant: MediaDownloadGrant, tokenHash: string): string {
  const payload = Buffer.from(JSON.stringify(grantSchema.parse(grant))).toString('base64url')
  return `${payload}.${signature(payload, tokenHash).toString('base64url')}`
}

/** Parse only; callers must verify the signature before using these claims. */
export function parseMediaDownloadGrant(value: string): MediaDownloadGrant | undefined {
  if (value.length > 2048) return undefined
  const parts = value.split('.')
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return undefined
  try {
    const payload = Buffer.from(parts[0]!, 'base64url')
    if (payload.toString('base64url') !== parts[0]) return undefined
    return grantSchema.parse(JSON.parse(payload.toString('utf8')))
  }
  catch { return undefined }
}

export function verifyMediaDownloadGrant(value: string, tokenHash: string, now = Date.now()): MediaDownloadGrant | undefined {
  const grant = parseMediaDownloadGrant(value)
  if (!grant || grant.expiresAt <= now || grant.expiresAt > now + MEDIA_DOWNLOAD_TTL_MS) return undefined
  const [payload, encodedSignature] = value.split('.')
  const supplied = Buffer.from(encodedSignature!, 'base64url')
  const expected = signature(payload!, tokenHash)
  if (supplied.toString('base64url') !== encodedSignature || supplied.length !== expected.length
    || !timingSafeEqual(supplied, expected)) return undefined
  return grant
}

function signature(payload: string, tokenHash: string): Buffer {
  return createHmac('sha256', tokenHash).update(`whatsapp-media-download-v1:${payload}`).digest()
}
