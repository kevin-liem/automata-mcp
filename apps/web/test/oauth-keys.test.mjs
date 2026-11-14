import assert from 'node:assert/strict'
import { createPrivateKey } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const script = fileURLToPath(new URL('../modules/mcp-oauth/keys.mjs', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'automata-oauth-keys-'))
const names = ['NUXT_MCP_OAUTH_COOKIE_KEY', 'NUXT_MCP_OAUTH_ENCRYPTION_KEY', 'NUXT_MCP_OAUTH_JWKS']
after(() => rmSync(directory, { recursive: true, force: true }))

function run(...args) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [script, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 10_000 })
}

function validate(text) {
  const values = parseEnv(text)
  assert.match(values.NUXT_MCP_OAUTH_COOKIE_KEY, /^[a-f0-9]{64}$/)
  assert.match(values.NUXT_MCP_OAUTH_ENCRYPTION_KEY, /^[a-f0-9]{64}$/)
  const { keys } = JSON.parse(values.NUXT_MCP_OAUTH_JWKS)
  assert.equal(keys.length, 1)
  assert.ok(keys[0].kid)
  assert.equal(createPrivateKey({ key: keys[0], format: 'jwk' }).asymmetricKeyType, 'rsa')
  return values
}

test('key generator writes a new env file without stdout redirection', () => {
  const target = join(directory, 'new.env')
  const result = run('--append-env', target)
  assert.equal(result.status, 0, result.stderr)
  validate(readFileSync(target, 'utf8'))
  assert.ok(result.stdout.includes('OAuth keys appended'))
  assert.ok(!result.stdout.includes('NUXT_MCP_OAUTH_'), 'success output must not expose generated keys')
})

test('key generator preserves settings and separates a final line without a newline', () => {
  const target = join(directory, 'existing.env')
  const original = 'NUXT_PUBLIC_APP_URL=https://automata.example\nOTHER_SETTING=keep\nNUXT_MCP_OAUTH_COOKIE_KEY='
  writeFileSync(target, original)
  assert.equal(run('--append-env', target).status, 0)
  const text = readFileSync(target, 'utf8')
  assert.ok(text.startsWith(original + '\n'))
  assert.equal(validate(text).OTHER_SETTING, 'keep')
})

test('key generator accepts empty quoted placeholders and preserves CRLF files', () => {
  const target = join(directory, 'windows.env')
  const original = 'OTHER_SETTING=keep\r\nNUXT_MCP_OAUTH_COOKIE_KEY=""\r\nNUXT_MCP_OAUTH_ENCRYPTION_KEY=\'\'\r\n'
  writeFileSync(target, original)
  assert.equal(run('--append-env', target).status, 0)
  const text = readFileSync(target, 'utf8')
  assert.ok(text.startsWith(original))
  assert.equal(text.replaceAll('\r\n', '').includes('\n'), false)
  validate(text)
})

test('key generator refuses to rotate any existing OAuth key', () => {
  for (const name of names) {
    const target = join(directory, `${name}.env`)
    const original = `OTHER_SETTING=keep\nexport ${name}='already configured'\n`
    writeFileSync(target, original)
    const result = run('--append-env', target)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already exist/)
    assert.equal(readFileSync(target, 'utf8'), original)
    assert.equal(result.stdout, '')
  }
})

test('key generator retains stdout output when no file option is supplied', () => {
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(Object.keys(validate(result.stdout)).sort(), names.toSorted())
  assert.equal(existsSync(join(directory, '.env')), false)
})

test('invalid key generator arguments fail before creating a file', () => {
  const target = join(directory, 'invalid.env')
  for (const args of [['--append-env'], ['--unknown', target], ['--append-env', target, 'extra']]) {
    const result = run(...args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:/)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(target), false)
  }
})
