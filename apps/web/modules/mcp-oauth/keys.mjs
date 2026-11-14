import { generateKeyPairSync, randomBytes } from 'node:crypto'

// Run once and append directly to a gitignored .env, never to a tracked file.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwks = { keys: [{
  ...privateKey.export({ format: 'jwk' }),
  kid: randomBytes(12).toString('hex'),
  alg: 'RS256',
  use: 'sig',
}] }
process.stdout.write(`NUXT_MCP_OAUTH_COOKIE_KEY=${randomBytes(32).toString('hex')}\n`)
process.stdout.write(`NUXT_MCP_OAUTH_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`)
process.stdout.write(`NUXT_MCP_OAUTH_JWKS='${JSON.stringify(jwks)}'\n`)
