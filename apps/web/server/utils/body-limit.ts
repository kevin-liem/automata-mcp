import type { H3Event } from 'h3'

/**
 * Request body size caps. Nothing upstream sets one — Nitro's node server is a
 * bare `node:http` server and the repo ships no proxy — and h3's `readRawBody`
 * buffers until `end`, after which JSON parsing costs ~21x the body in heap.
 * One anonymous login body of a few hundred MiB would take the whole process
 * (every tenant's UI, /mcp, webhooks, scheduled tasks) down with it.
 *
 * So every body is read through `readCappedBody`, which refuses an oversized
 * `Content-Length` before reading a byte and stops a chunked body the moment it
 * passes the cap. It stores its promise where h3 caches the raw body, so every
 * later reader — `readBody`, `readRawBody`, the MCP toolkit's `toWebRequest` —
 * replays the capped buffer instead of attaching its own unbounded listener.
 */

/** Default for `/api/**`: every schema there fits in a few KiB (a passkey response is the largest). */
export const API_BODY_LIMIT = 64 * 1024
/** Token create / scope edit: `chat_jids` and `table_names` are unbounded lists the picker fills. */
export const SCOPE_BODY_LIMIT = 1024 * 1024
/** Evolution and bridge webhooks: connection-state events only, but not ours to size exactly. */
export const WEBHOOK_BODY_LIMIT = 256 * 1024
/**
 * /mcp, applied after the token authenticates. `create-email-draft` takes 100 000
 * characters of body (up to 6 bytes each once JSON-escaped), `run-query` 20 000.
 */
export const MCP_BODY_LIMIT = 2 * 1024 * 1024

const RawBodySymbol = Symbol.for('h3RawBody')
const PAYLOAD_METHODS = new Set(['PATCH', 'POST', 'PUT', 'DELETE'])

/** The cap for a non-MCP path. MCP is capped separately, after auth. */
export function bodyLimitFor(path: string): number {
  const [pathname = ''] = path.split('?')
  if (pathname.startsWith('/api/webhook/')) return WEBHOOK_BODY_LIMIT
  if (/^\/api\/instances\/[^/]+\/tokens\/?$/.test(pathname)) return SCOPE_BODY_LIMIT
  if (/^\/api\/tokens\/[^/]+\/?$/.test(pathname)) return SCOPE_BODY_LIMIT
  return API_BODY_LIMIT
}

function tooLarge(event: H3Event, limit: number) {
  // The rest of the body is never read, so the connection cannot be reused.
  event.node.res.setHeader('connection', 'close')
  return createError({
    statusCode: 413,
    statusMessage: 'Payload Too Large',
    message: `Request body is larger than ${limit} bytes`,
  })
}

/**
 * Read the request body into h3's raw-body cache, holding it to `limit` bytes.
 * Throws 413 when the body is larger. A no-op for methods without a body and
 * for a body already read (it was read through here, under a cap).
 */
export async function readCappedBody(event: H3Event, limit: number): Promise<void> {
  if (!PAYLOAD_METHODS.has(event.method)) return
  const req = event.node.req as typeof event.node.req & { [RawBodySymbol]?: Promise<Buffer> }
  if (req[RawBodySymbol]) {
    await req[RawBodySymbol]
    return
  }

  const declared = req.headers['content-length']
  const chunked = /\bchunked\b/i.test(String(req.headers['transfer-encoding'] ?? ''))
  if (declared !== undefined && !chunked) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'Invalid Content-Length' })
    }
    if (length > limit) throw tooLarge(event, limit)
    // Same test h3 makes: no body at all leaves the cache empty, as before.
    if (length === 0) return
  }
  else if (!chunked) {
    return
  }

  const promise = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        cleanup()
        chunks.length = 0
        reject(tooLarge(event, limit))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    req.on('data', onData).on('end', onEnd).on('error', onError)
  })
  req[RawBodySymbol] = promise
  await promise
}
