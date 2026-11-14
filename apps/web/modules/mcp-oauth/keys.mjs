import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--append-env' || !args[1])) {
    throw new Error('Usage: node apps/web/modules/mcp-oauth/keys.mjs [--append-env .env]')
  }
  const target = args[1]
  let existing = ''
  if (target) {
    try { existing = readFileSync(target, 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const values = parseEnv(existing)
    if (['NUXT_MCP_OAUTH_COOKIE_KEY', 'NUXT_MCP_OAUTH_ENCRYPTION_KEY', 'NUXT_MCP_OAUTH_JWKS'].some(name => values[name])) {
      throw new Error(`OAuth keys already exist in ${target}; leaving the file unchanged.`)
    }
  }

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwks = { keys: [{
    ...privateKey.export({ format: 'jwk' }),
    kid: randomBytes(12).toString('hex'),
    alg: 'RS256',
    use: 'sig',
  }] }
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  const output = [
    `NUXT_MCP_OAUTH_COOKIE_KEY=${randomBytes(32).toString('hex')}`,
    `NUXT_MCP_OAUTH_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    `NUXT_MCP_OAUTH_JWKS='${JSON.stringify(jwks)}'`,
    '',
  ].join(newline)
  if (target) {
    // Write without shell redirection: Git Bash's winpty node wrapper needs
    // stdout attached to a terminal. Keep existing settings and the last line.
    const separator = existing && !existing.endsWith('\n') ? newline : ''
    appendFileSync(target, separator + output, { mode: 0o600 })
    process.stdout.write(`OAuth keys appended to ${target}.\n`)
  }
  else process.stdout.write(output)
}

try { main() }
catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
