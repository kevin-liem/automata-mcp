import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function seal(key: Buffer, value: string, context: string): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body])
}

export function unseal(key: Buffer, value: Buffer, context: string): string {
  const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
  cipher.setAAD(Buffer.from(context))
  cipher.setAuthTag(value.subarray(12, 28))
  return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
}

export function csrfToken(key: Buffer, session: string, ...context: string[]): string {
  return createHmac('sha256', key).update(JSON.stringify([session, ...context])).digest('base64url')
}

export function matchesToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  const supplied = Buffer.from(actual)
  const correct = Buffer.from(expected)
  return supplied.length === correct.length && timingSafeEqual(supplied, correct)
}
