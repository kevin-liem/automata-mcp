import { lookup } from 'node:dns/promises'
import { get } from 'node:https'
import { BlockList, isIP } from 'node:net'

// Unlike user-supplied connection targets, OAuth metadata is always public,
// even when the operator enabled ALLOW_PRIVATE_TARGETS for their databases.
const denied4 = new BlockList()
const denied6 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied4.addSubnet(address, prefix)
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
] as const) denied6.addSubnet(address, prefix, 'ipv6')

export function publicMetadataAddress(address: string, family: number): boolean {
  return isIP(address) !== 0 && address !== '::1'
    && !(family === 6 ? denied6 : denied4).check(address, family === 6 ? 'ipv6' : 'ipv4')
}

/** Pinned DNS, no redirects, no cookies, five seconds, at most 64 KiB. */
export const fetchClientMetadata: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || url.pathname === '/' || (url.port && url.port !== '443')) {
    throw new Error('Client metadata must use a public HTTPS URL with a path.')
  }
  const signal = AbortSignal.timeout(5000)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  ])
  if (!addresses.length || !addresses.every(a => publicMetadataAddress(a.address, a.family))) {
    throw new Error('Client metadata must resolve only to public addresses.')
  }
  signal.throwIfAborted()
  const target = addresses[0]!
  return await new Promise<Response>((resolve, reject) => {
    const request = get(url, {
      signal,
      headers: { accept: 'application/json' },
      family: target.family,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 64 * 1024) {
          request.destroy(new Error('Client metadata is too large.'))
          return
        }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => {
        if (res.statusCode !== 200 || !String(res.headers['content-type']).includes('application/json')) {
          reject(new Error('Client metadata must return HTTP 200 application/json without redirects.'))
          return
        }
        resolve(new Response(Buffer.concat(chunks), { headers: { 'content-type': 'application/json' } }))
      })
    })
    request.on('error', reject)
  })
}
