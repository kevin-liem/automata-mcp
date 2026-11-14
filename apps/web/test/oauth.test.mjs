import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import * as h3 from 'h3'

// Published at https://chatgpt.com/oauth/client.json (2026-11-14).
const chatgptMetadata = JSON.parse(readFileSync(new URL('./fixtures/chatgpt-oauth-client.json', import.meta.url), 'utf8'))

// Run the real Nuxt utilities under Node's TS stripper, without a Nuxt server.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '#shared/connection') return next(new URL('../shared/connection.ts', import.meta.url).href, context)
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../', import.meta.url).href)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
  }
  return next(specifier, context)
} })

const { readOAuthConfig, oauthEnabled } = await import('../modules/mcp-oauth/runtime/config.ts')
const { oauthReturnPath } = await import('../modules/mcp-oauth/shared.ts')
const { digest, seal, unseal } = await import('../modules/mcp-oauth/runtime/crypto.ts')
const { publicMetadataAddress, fetchClientMetadata } = await import('../modules/mcp-oauth/runtime/metadata.ts')
const { negotiateCimdCapabilities } = await import('../modules/mcp-oauth/runtime/client-metadata.ts')
const { createOAuthService } = await import('../modules/mcp-oauth/runtime/service.ts')
const { handleOAuthRequest } = await import('../modules/mcp-oauth/runtime/http.ts')
const { postgresAdapter } = await import('../modules/mcp-oauth/runtime/storage.ts')
const { appDb, getRow, appDbUnavailable } = await import('../server/utils/app-db.ts')
const { authorizesInstance } = await import('../server/utils/org.ts')
const { hashMcpToken, resolveMcpAuthHash, resolveMediaDownloadAuth } = await import('../server/utils/mcp-auth.ts')
const { getSessionUser, currentSessionHash } = await import('../server/utils/session.ts')
const { readCappedBody, bodyLimitFor } = await import('../server/utils/body-limit.ts')
const { signMediaDownloadGrant } = await import('../server/utils/media-download-grant.ts')
const { authenticateMcpRequest } = await import('../modules/mcp-oauth/runtime/runtime.ts')
const { default: disabledHandler } = await import('../modules/mcp-oauth/runtime/handler.ts')

function settings() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    enabled: true,
    cookieKey: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('hex'),
    jwks: JSON.stringify({ keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'oauth-test', alg: 'RS256', use: 'sig' }] }),
  }
}

test('OAuth configuration and login destinations are explicit and safe', () => {
  const values = settings()
  assert.equal(oauthEnabled({ enabled: 'false' }), false)
  assert.equal(oauthEnabled({ enabled: 'true' }), true)
  assert.equal(readOAuthConfig(values, 'https://automata.test').resource, 'https://automata.test/mcp')
  assert.equal(readOAuthConfig(values, 'https://automata.test/').resource, 'https://automata.test/mcp')
  assert.ok(readOAuthConfig({ ...values, jwks: JSON.parse(values.jwks) }, 'https://automata.test').jwks.keys.length)
  assert.throws(() => readOAuthConfig(values, 'http://automata.test'), /HTTPS/)
  assert.throws(() => readOAuthConfig(values, 'http://localhost:3000'), /HTTPS/)
  assert.ok(readOAuthConfig(values, 'http://localhost:3000', true))
  for (const url of ['https://automata.test/subpath', 'https://name:secret@automata.test', 'https://automata.test/?token=x']) {
    assert.throws(() => readOAuthConfig(values, url))
  }
  assert.throws(() => readOAuthConfig({ ...values, cookieKey: '' }, 'https://automata.test'), /COOKIE_KEY/)
  assert.throws(() => readOAuthConfig({ ...values, jwks: '{}' }, 'https://automata.test'), /JWKS/)
  assert.equal(oauthReturnPath('/oauth/connections'), '/oauth/connections')
  assert.equal(oauthReturnPath(`/oauth/interaction/${'a'.repeat(24)}`), `/oauth/interaction/${'a'.repeat(24)}`)
  for (const value of ['https://evil.test', '//evil.test', '/instances', '/oauth/connections?next=evil', ['/oauth/connections']]) {
    assert.equal(oauthReturnPath(value), undefined)
  }
})

test('OAuth encryption binds each payload to its model and hashed identifier', () => {
  const key = randomBytes(32)
  const cipher = seal(key, 'private-value', 'AccessToken:one')
  assert.equal(cipher.includes(Buffer.from('private-value')), false)
  assert.equal(unseal(key, cipher, 'AccessToken:one'), 'private-value')
  assert.throws(() => unseal(key, cipher, 'RefreshToken:one'))
  assert.throws(() => unseal(key, cipher, 'AccessToken:two'))
})

test('client metadata cannot reach private networks or non-HTTPS URLs', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '::1', '::ffff:7f00:1', 'fc00::1', '64:ff9b::7f00:1']) {
    assert.equal(publicMetadataAddress(address, address.includes(':') ? 6 : 4), false, address)
  }
  assert.equal(publicMetadataAddress('8.8.8.8', 4), true)
  await assert.rejects(fetchClientMetadata('http://example.test/client.json'), /HTTPS/)
  await assert.rejects(fetchClientMetadata('https://127.0.0.1/client.json'), /public/)
})

test('CIMD capability negotiation selects only published public-client methods and supported grants', async () => {
  const normalized = negotiateCimdCapabilities(async () => Response.json(chatgptMetadata, {
    headers: { 'cache-control': 'max-age=300', 'content-length': '9999', etag: 'original' },
  }))
  const response = await normalized(chatgptMetadata.client_id)
  const metadata = await response.json()
  assert.equal(metadata.client_id, chatgptMetadata.client_id)
  assert.equal(metadata.token_endpoint_auth_method, 'none')
  assert.equal(metadata.token_endpoint_auth_signing_alg, undefined)
  assert.deepEqual(metadata.grant_types, ['authorization_code', 'refresh_token'])
  assert.deepEqual(metadata.redirect_uris, chatgptMetadata.redirect_uris)
  assert.equal(response.headers.get('cache-control'), 'max-age=300')
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('etag'), null)
  assert.equal(chatgptMetadata.token_endpoint_auth_method, 'private_key_jwt', 'the published fixture must remain unchanged')
})

test('CIMD negotiation fails closed when public PKCE or authorization-code capability is absent', async () => {
  for (const patch of [
    { token_endpoint_auth_methods_supported: ['private_key_jwt'] },
    { token_endpoint_auth_methods_supported: 'none' },
    { token_endpoint_auth_methods_supported: ['none', 42] },
    { token_endpoint_auth_method: 'client_secret_post' },
    { grant_types: ['urn:ietf:params:oauth:grant-type:jwt-bearer'] },
    { grant_types: ['authorization_code', 42] },
  ]) {
    const normalized = negotiateCimdCapabilities(async () => Response.json({ ...chatgptMetadata, ...patch }))
    await assert.rejects(normalized(chatgptMetadata.client_id))
  }
  const legacy = { ...chatgptMetadata }
  delete legacy.token_endpoint_auth_methods_supported
  const normalized = negotiateCimdCapabilities(async () => Response.json(legacy))
  assert.equal((await (await normalized(legacy.client_id)).json()).token_endpoint_auth_method, 'private_key_jwt')
  const wrongIdentity = negotiateCimdCapabilities(async () => Response.json(chatgptMetadata))
  assert.equal((await (await wrongIdentity('https://other.example/client.json')).json()).client_id, chatgptMetadata.client_id)
})

class Browser {
  constructor(origin, transport, session) {
    this.origin = origin
    this.transport = transport
    this.cookies = new Map()
    if (session) this.cookies.set('automata_session:/', { name: 'automata_session', value: session, path: '/' })
  }
  async fetch(path, init = {}) {
    const url = new URL(path, this.origin)
    assert.equal(url.origin, this.origin)
    const headers = new Headers(init.headers)
    if (!headers.has('cookie')) {
      const values = [...this.cookies.values()].filter(cookie => url.pathname === cookie.path
        || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/'))
      if (values.length) headers.set('cookie', values.map(c => `${c.name}=${c.value}`).join('; '))
    }
    const response = await fetch(`${this.transport}${url.pathname}${url.search}`, { ...init, headers, redirect: 'manual' })
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(';').map(v => v.trim())
      const equals = pair.indexOf('=')
      const name = pair.slice(0, equals)
      const value = pair.slice(equals + 1)
      const path = attributes.find(v => /^path=/i.test(v))?.slice(5) ?? '/'
      const id = `${name}:${path}`
      if (!value || attributes.includes('Max-Age=0')) this.cookies.delete(id)
      else this.cookies.set(id, { name, value, path })
    }
    return response
  }
  post(path, fields, origin = this.origin) {
    return this.fetch(path, { method: 'POST', headers: { origin }, body: new URLSearchParams(fields) })
  }
}

function location(response) {
  const value = response.headers.get('location')
  assert.ok(value, `expected redirect from HTTP ${response.status}`)
  return value
}

function csrf(html) {
  const value = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.ok(value, 'expected consent CSRF field')
  return value
}

test('OAuth flows use real Automata authorization and PostgreSQL storage', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to a local PostgreSQL server with CREATEDB permission.',
  timeout: 120_000,
}, async (t) => {
  const admin = postgres(process.env.TEST_DATABASE_URL, { max: 1, onnotice: () => {} })
  const database = `automata_oauth_test_${randomUUID().replaceAll('-', '')}`
  await admin`CREATE DATABASE ${admin(database)}`
  const testUrl = new URL(process.env.TEST_DATABASE_URL)
  testUrl.pathname = `/${database}`
  const values = settings()
  const origin = 'https://automata.test'
  const config = readOAuthConfig(values, origin)
  const runtime = { databaseUrl: testUrl.href, public: { appUrl: origin }, mcpOauth: values }
  Object.assign(globalThis, {
    ...h3, appDb, getRow, appDbUnavailable, authorizesInstance,
    useRuntimeConfig: () => runtime,
    instanceKind: instance => instance.kind,
    scopeFromRecord: row => ({
      allChats: row.all_chats, chatJids: row.chat_jids, allTables: row.all_tables, tableNames: row.table_names,
      allTools: row.all_tools, toolNames: row.tool_names,
    }),
    credentialsForInstance: row => row.api_key ? { baseUrl: row.base_url, apiKey: row.api_key } : undefined,
    telegramCredentialsForInstance: row => row.api_key ? { baseUrl: row.base_url, apiKey: row.api_key, sessionId: row.instance_id } : undefined,
  })
  let db
  let server
  try {
    db = await appDb()
    await db`INSERT INTO app.users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'test'), ('bob', 'bob@example.test', 'test'), ('member', 'member@example.test', 'test')`
    await db`INSERT INTO app.organizations (id, name) VALUES ('org-a', 'Alice Org'), ('org-b', 'Bob Org')`
    await db`INSERT INTO app.memberships (org, user_id, role) VALUES ('org-a', 'alice', 'admin'), ('org-b', 'bob', 'admin'), ('org-a', 'member', 'member')`
    await db`INSERT INTO app.instances (id, org, kind, name, label, dsn)
      VALUES ('connection-a', 'org-a', 'postgres', 'Alice Database', 'Primary database', 'postgresql://example.invalid/a'),
        ('connection-b', 'org-b', 'postgres', 'Bob Database', 'Other database', 'postgresql://example.invalid/b')`
    await db`INSERT INTO app.instance_assignments (instance, user_id) VALUES ('connection-a', 'member')`
    const native = 'wamcp_test_alice_private_credential'
    const memberNative = 'wamcp_test_member_private_credential'
    await db`INSERT INTO app.mcp_tokens (id, assigned_to, instance, label, token_hash, all_tools, tool_names)
      VALUES ('policy-a', 'alice', 'connection-a', 'Alice policy', ${hashMcpToken(native)}, false, ${['list-tables']}),
        ('policy-b', 'bob', 'connection-b', 'Bob policy', ${hashMcpToken('wamcp_test_bob_private')}, true, ${[]}),
        ('policy-member', 'member', 'connection-a', 'Member policy', ${hashMcpToken(memberNative)}, false, ${['list-tables']})`
    for (const user of ['alice', 'bob', 'member']) {
      await db`INSERT INTO app.sessions (user_id, token_hash, expires_at) VALUES (${user}, ${digest(`session-${user}`)}, now() + interval '14 days')`
    }
    const metadata = async input => {
      const id = input instanceof Request ? input.url : input.toString()
      if (id === chatgptMetadata.client_id) return Response.json(chatgptMetadata)
      if (id === 'https://chatgpt.com/oauth/private-only/client.json') return Response.json({
        ...chatgptMetadata, client_id: id, token_endpoint_auth_methods_supported: ['private_key_jwt'],
      })
      const codex = id === 'https://chatgpt.com/oauth/codex/client.json'
      const claude = id === 'https://claude.ai/oauth/mcp-oauth-client-metadata'
      assert.ok(codex || claude, `unexpected metadata fetch: ${id}`)
      return Response.json({
        client_id: id, client_name: codex ? 'Codex' : 'Claude',
        application_type: codex ? 'native' : 'web',
        redirect_uris: codex ? ['http://localhost/callback', 'http://127.0.0.1/callback'] : ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      })
    }
    let service = await createOAuthService(config, db, resolveMcpAuthHash, metadata)
    const app = h3.createApp()
    app.use(h3.defineEventHandler(async event => {
      const path = event.path.split('?')[0]
      if (!path.startsWith('/mcp')) {
        await readCappedBody(event, bodyLimitFor(event.path))
        event.context.user = await getSessionUser(event)
      }
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        if (path.startsWith('/mcp/')) event.context.params = { token: path.slice(5) }
        const auth = await authenticateMcpRequest(event)
        return auth instanceof Response ? auth : { tokenId: auth.tokenId, user: auth.user.id, kind: auth.kind, scope: auth.scope }
      }
      if (!values.enabled) return disabledHandler(event)
      return await handleOAuthRequest(event, service, currentSessionHash(event))
    }))
    server = createServer(h3.toNodeListener(app))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    let transport = `http://127.0.0.1:${server.address().port}`
    const browser = user => new Browser(origin, transport, user && `session-${user}`)
    let client = browser()
    const codex = { client_id: 'https://chatgpt.com/oauth/codex/client.json', callback: 'http://localhost:18765/callback' }
    const claude = { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', callback: 'https://claude.ai/api/mcp/auth_callback' }
    const chatgpt = { client_id: chatgptMetadata.client_id, callback: chatgptMetadata.redirect_uris[0] }
    async function register(callback, name = 'Gemini', authMethod = 'none') {
      const response = await client.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        client_name: name, application_type: 'web', redirect_uris: [callback], token_endpoint_auth_method: authMethod,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }) })
      assert.equal(response.status, 201, await response.clone().text())
      return { ...await response.json(), callback }
    }
    const gemini = await register('https://oauth-redirect.googleusercontent.com/r/automata-test', 'Gemini', 'client_secret_post')
    async function start(who, agent = gemini, overrides = {}) {
      const verifier = randomBytes(32).toString('base64url')
      const params = new URLSearchParams({ client_id: agent.client_id, redirect_uri: agent.callback, response_type: 'code',
        state: 'test-state', scope: 'mcp:use offline_access', resource: config.resource,
        code_challenge: digestBase64(verifier), code_challenge_method: 'S256', ...overrides })
      return { response: await who.fetch(`/oauth/authorize?${params}`), verifier }
    }
    async function approve(who, token = 'policy-a', agent = gemini) {
      const { response, verifier } = await start(who, agent)
      assert.equal(response.status, 303, await response.clone().text())
      const path = new URL(location(response), origin).pathname
      const consent = await who.fetch(path)
      assert.equal(consent.status, 200, await consent.clone().text())
      const html = await consent.text()
      assert.ok(html.includes(new URL(agent.callback).host))
      assert.ok(!html.includes(native), 'consent must not expose the MCP secret')
      const finish = await who.post(path, { csrf: csrf(html), decision: 'allow', token })
      assert.equal(finish.status, 200, await finish.clone().text())
      const resumePath = finish.headers.get('refresh')?.replace('0; url=', '')
      assert.ok(resumePath)
      const resume = await who.fetch(resumePath)
      const returned = new URL(location(resume), origin)
      assert.equal(returned.origin, new URL(agent.callback).origin, `authorization did not finish: ${returned}`)
      assert.equal(returned.searchParams.get('state'), 'test-state')
      assert.equal(returned.searchParams.get('iss'), origin)
      const code = returned.searchParams.get('code')
      assert.ok(code, `expected OAuth code, got ${returned}`)
      return { code, verifier, html }
    }
    async function exchange(agent, fields) {
      return await client.fetch('/oauth/token', { method: 'POST', body: new URLSearchParams({ client_id: agent.client_id,
        ...(agent.client_secret ? { client_secret: agent.client_secret } : {}), resource: config.resource, ...fields }) })
    }
    async function issue(user = 'alice', token = 'policy-a', agent = gemini) {
      const approved = await approve(browser(user), token, agent)
      const response = await exchange(agent, { grant_type: 'authorization_code', code: approved.code, code_verifier: approved.verifier, redirect_uri: agent.callback })
      assert.equal(response.status, 200, await response.clone().text())
      return await response.json()
    }
    const call = access => client.fetch('/mcp', { method: 'POST', headers: { authorization: `Bearer ${access}` } })
    const refresh = (tokens, agent = gemini) => exchange(agent, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })

    await t.test('discovery and the MCP challenge point to this Automata instance', async () => {
      const response = await client.fetch('/mcp', { method: 'POST' })
      assert.equal(response.status, 401)
      assert.match(response.headers.get('www-authenticate'), /resource_metadata="https:\/\/automata.test\/\.well-known\/oauth-protected-resource\/mcp"/)
      const resource = await (await client.fetch('/.well-known/oauth-protected-resource/mcp')).json()
      assert.equal(resource.resource, config.resource)
      assert.equal(resource.resource_name, 'DOPE MCP')
      const metadata = await (await client.fetch('/.well-known/oauth-authorization-server')).json()
      assert.ok(metadata.registration_endpoint.endsWith('/oauth/register'))
      assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
      assert.ok(metadata.token_endpoint_auth_methods_supported.includes('none'))
      assert.equal(metadata.client_id_metadata_document_supported, true)
      assert.equal(metadata.authorization_response_iss_parameter_supported, true)
    })
    await t.test('unauthenticated consent returns through the existing login', async () => {
      const who = browser()
      const { response } = await start(who)
      const path = new URL(location(response), origin).pathname
      assert.equal(location(await who.fetch(path)), `/login?oauth_return=${encodeURIComponent(path)}`)
    })
    await t.test('viewing available policies does not mark connector tokens as used', async () => {
      const who = browser('alice')
      const { response } = await start(who)
      const path = new URL(location(response), origin).pathname
      assert.equal((await who.fetch(path)).status, 200)
      const used = await db`SELECT id FROM app.mcp_tokens WHERE last_used_at IS NOT NULL`
      assert.equal(used.length, 0)
    })
    await t.test('approval keeps the browser form origin, displays its ten-minute deadline, and uses DOPE branding', async () => {
      const who = browser('alice')
      const { response } = await start(who)
      const path = new URL(location(response), origin).pathname
      const consent = await who.fetch(path)
      assert.equal(consent.headers.get('referrer-policy'), 'same-origin')
      const html = await consent.text()
      assert.match(html, /← DOPE/)
      assert.ok(!html.includes('Automata'))
      const interaction = await service.provider.Interaction.find(path.split('/').at(-1))
      assert.equal(interaction.exp - interaction.iat, 600)
      assert.ok(html.includes(new Date(interaction.exp * 1000).toISOString()))
      assert.match(html, /This approval link expires at/)
      const localTimeScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
      assert.ok(localTimeScript, 'the device must format its own local deadline')
      const scriptHash = createHash('sha256').update(localTimeScript).digest('base64')
      const policy = consent.headers.get('content-security-policy')
      assert.ok(policy.includes(`script-src 'sha256-${scriptHash}'`), 'only the fixed local-time script is allowed to execute')
      assert.ok(!/script-src[^;]*unsafe-inline/.test(policy))
    })
    await t.test('consent uses the saved connection label and connector name, with tools but no chat list', async () => {
      const hiddenChat = '6281234567890@s.whatsapp.net'
      const internalName = 'i-auto-generated-work-phone'
      await db`INSERT INTO app.instances (id, org, kind, name, label, instance_id, api_key, base_url)
        VALUES ('ui-work-phone', 'org-a', 'whatsapp', ${internalName}, 'Work Phone', 'test-session', 'test-key', 'https://example.invalid')`
      await db`INSERT INTO app.mcp_tokens (id, assigned_to, instance, label, token_hash, all_chats, chat_jids, all_tools, tool_names)
        VALUES ('ui-work-policy', 'alice', 'ui-work-phone', 'Codex', ${hashMcpToken('wamcp_ui_work_phone')}, false, ${[hiddenChat]}, false, ${['list-chats', 'read-messages']})`
      try {
        const who = browser('alice')
        const { response } = await start(who)
        const path = new URL(location(response), origin).pathname
        const html = await (await who.fetch(path)).text()
        assert.match(html, /WhatsApp - Work Phone/)
        assert.match(html, /Connector name: Codex/)
        assert.match(html, /list-chats, read-messages/)
        assert.ok(!html.includes(internalName))
        assert.ok(!html.includes(hiddenChat))
        assert.ok(!html.includes('All chats'))
        assert.ok(!html.includes('All tables'))
        const choice = (await service.choices('alice')).find(choice => choice.row.id === 'ui-work-policy')
        assert.equal(choice.row.connection_name, 'Work Phone')
        assert.equal(choice.auth.scope.allChats, false)
        assert.deepEqual(choice.auth.scope.chatJids, [hiddenChat], 'hidden chat restrictions must remain enforced')
        await db`UPDATE app.instances SET label = '' WHERE id = 'ui-work-phone'`
        const unnamed = await (await who.fetch(path)).text()
        assert.match(unnamed, /<strong>WhatsApp<\/strong>/)
        assert.ok(!unnamed.includes(internalName), 'missing display labels must never fall back to internal names')
        await db`UPDATE app.instances SET label = 'Work <script>injected()</script>' WHERE id = 'ui-work-phone'`
        const escaped = await (await who.fetch(path)).text()
        assert.ok(escaped.includes('Work &lt;script&gt;injected()&lt;/script&gt;'))
        assert.ok(!escaped.includes('<script>injected()</script>'))
      }
      finally {
        await db`DELETE FROM app.mcp_tokens WHERE id = 'ui-work-policy'`
        await db`DELETE FROM app.instances WHERE id = 'ui-work-phone'`
      }
    })
    await t.test('Gemini DCR, Codex CIMD with ephemeral localhost port, and Claude CIMD complete the flow', async () => {
      for (const agent of [gemini, codex, claude]) {
        const tokens = await issue('alice', 'policy-a', agent)
        assert.ok(tokens.refresh_token)
        assert.equal(tokens.expires_in, 3600)
        const response = await call(tokens.access_token)
        assert.equal(response.status, 200, await response.clone().text())
        const auth = await response.json()
        assert.equal(auth.user, 'alice')
        assert.equal(auth.tokenId, 'policy-a')
        assert.deepEqual(auth.scope.toolNames, ['list-tables'])
      }
    })
    await t.test('ChatGPT published CIMD negotiates public-client PKCE despite its JWT preference', async () => {
      const tokens = await issue('alice', 'policy-a', chatgpt)
      assert.equal((await call(tokens.access_token)).status, 200)
      const renewed = await refresh(tokens, chatgpt)
      assert.equal(renewed.status, 200, await renewed.clone().text())
      const registered = await service.provider.Client.find(chatgpt.client_id)
      assert.equal(registered.clientAuthMethod, 'none')
      assert.deepEqual(registered.grantTypes.sort(), ['authorization_code', 'refresh_token'])
    })
    await t.test('ChatGPT still requires PKCE and cannot use the unsupported JWT bearer grant', async () => {
      const approved = await approve(browser('alice'), 'policy-a', chatgpt)
      const refused = await exchange(chatgpt, {
        grant_type: 'authorization_code', code: approved.code, code_verifier: 'wrong'.repeat(12), redirect_uri: chatgpt.callback,
      })
      assert.equal(refused.status, 400)
      assert.equal((await refused.json()).error, 'invalid_grant')
      const jwtGrant = await exchange(chatgpt, {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'not-a-valid-assertion',
      })
      assert.equal(jwtGrant.status, 400)
      assert.equal((await jwtGrant.json()).error, 'unsupported_grant_type')
      const invalidRegistration = await client.fetch('/oauth/register', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          client_name: 'Unsupported DCR grant', redirect_uris: [chatgpt.callback], token_endpoint_auth_method: 'none',
          grant_types: chatgptMetadata.grant_types, response_types: ['code'],
        }),
      })
      assert.equal(invalidRegistration.status, 400)
    })
    await t.test('incompatible client metadata returns a protocol error and support reference without exposing the request', async () => {
      const agent = { ...chatgpt, client_id: 'https://chatgpt.com/oauth/private-only/client.json' }
      const { response, verifier } = await start(browser('alice'), agent)
      assert.ok(response.status >= 400)
      const body = await response.text()
      assert.match(body, /Error: invalid_client/)
      const reference = response.headers.get('x-request-id')
      assert.match(reference, /^[a-f0-9-]{36}$/)
      assert.ok(body.includes(reference))
      assert.ok(!body.includes(verifier))
      assert.ok(!body.includes('session-alice'))
      assert.ok(!body.includes('test-state'))
    })
    await t.test('cookies never authenticate MCP; native header and path tokens still work', async () => {
      assert.equal((await browser('alice').fetch('/mcp', { method: 'POST' })).status, 401)
      assert.equal((await call(native)).status, 200)
      assert.equal((await client.fetch(`/mcp/${native}`)).status, 200)
      assert.equal((await client.fetch(`/mcp/${native}`, { headers: { authorization: 'Basic bad' } })).status, 401)
      const tokens = await issue()
      assert.equal((await client.fetch(`/mcp/${tokens.access_token}`)).status, 401)
    })
    await t.test('OAuth reaches the same WhatsApp, Telegram and IMAP kinds as native tokens', async () => {
      for (const kind of ['whatsapp', 'telegram', 'imap']) {
        const id = `connection-${kind}`
        const secret = `wamcp_test_${kind}`
        await db`INSERT INTO app.instances (id, org, kind, name, instance_id, api_key, base_url, imap_host, imap_user)
          VALUES (${id}, 'org-a', ${kind}, ${kind}, 'test-session', 'test-key', 'https://example.invalid', 'imap.example.invalid', 'test-user')`
        await db`INSERT INTO app.mcp_tokens (id, assigned_to, instance, label, token_hash)
          VALUES (${`policy-${kind}`}, 'alice', ${id}, ${kind}, ${hashMcpToken(secret)})`
        const tokens = await issue('alice', `policy-${kind}`)
        const response = await call(tokens.access_token)
        assert.equal(response.status, 200)
        assert.equal((await response.json()).kind, kind)
      }
    })
    await t.test('one account cannot select another account’s policy', async () => {
      const who = browser('alice')
      const { response } = await start(who)
      const path = new URL(location(response), origin).pathname
      const html = await (await who.fetch(path)).text()
      assert.ok(!html.includes('Bob policy'))
      assert.ok(!html.includes('Member policy'))
      assert.equal((await who.post(path, { csrf: csrf(html), decision: 'allow', token: 'policy-b' })).status, 400)
    })
    await t.test('consent rejects cross-origin posts, wrong CSRF proofs and expired interactions', async () => {
      const who = browser('alice')
      const { response } = await start(who)
      const path = new URL(location(response), origin).pathname
      const html = await (await who.fetch(path)).text()
      const fields = { csrf: csrf(html), decision: 'allow', token: 'policy-a' }
      assert.equal((await who.post(path, fields, 'https://evil.test')).status, 403)
      assert.equal((await who.post(path, fields, 'null')).status, 403)
      const invalidForm = await who.post(path, { ...fields, csrf: 'wrong' })
      assert.equal(invalidForm.status, 403)
      const invalidHtml = await invalidForm.text()
      assert.match(invalidHtml, /Approval could not be verified/)
      assert.ok(!invalidHtml.includes('Approval expired'))
      assert.match(invalidHtml, /← DOPE/)
      await db`UPDATE mcp_oauth.records SET expires_at = now() - interval '1 second' WHERE model = 'Interaction'`
      for (const expired of [await who.post(path, fields), await who.fetch(path)]) {
        assert.equal(expired.status, 400)
        const expiredHtml = await expired.text()
        assert.match(expiredHtml, /Approval is no longer available/)
        assert.match(expiredHtml, /← DOPE/)
        assert.ok(!expiredHtml.includes('__NUXT'))
      }
    })
    await t.test('denial returns access_denied and does not grant access', async () => {
      const who = browser('alice')
      const { response } = await start(who)
      const path = new URL(location(response), origin).pathname
      const html = await (await who.fetch(path)).text()
      const finish = await who.post(path, { csrf: csrf(html), decision: 'deny' })
      const returned = new URL(location(await who.fetch(finish.headers.get('refresh').replace('0; url=', ''))))
      assert.equal(returned.searchParams.get('error'), 'access_denied')
    })
    await t.test('PKCE and audience mismatches are refused', async () => {
      const approved = await approve(browser('alice'))
      const fields = { grant_type: 'authorization_code', code: approved.code, redirect_uri: gemini.callback }
      assert.equal((await exchange(gemini, { ...fields, code_verifier: 'wrong'.repeat(12) })).status, 400)
      const badAudience = await start(browser('alice'), gemini, { resource: 'https://other.test/mcp' })
      const redirect = badAudience.response.headers.get('location')
      assert.ok(badAudience.response.status === 400 || (redirect && new URL(redirect, origin).searchParams.get('error')))
    })
    await t.test('authorization codes can be consumed only once, including concurrent requests', async () => {
      const approved = await approve(browser('alice'))
      const fields = { grant_type: 'authorization_code', code: approved.code, code_verifier: approved.verifier, redirect_uri: gemini.callback }
      const responses = await Promise.all([exchange(gemini, fields), exchange(gemini, fields)])
      assert.equal(responses.filter(r => r.status === 200).length, 1)
      assert.equal(responses.filter(r => r.status === 400).length, 1)
    })
    await t.test('simultaneous consent submissions leave only one approved authorization', async () => {
      const who = browser('alice')
      const { response } = await start(who)
      const path = new URL(location(response), origin).pathname
      const html = await (await who.fetch(path)).text()
      const before = (await service.authorizations('alice')).length
      const fields = { csrf: csrf(html), decision: 'allow', token: 'policy-a' }
      const responses = await Promise.all([who.post(path, fields), who.post(path, fields)])
      assert.equal(responses.filter(r => r.status === 200).length, 1)
      assert.equal((await service.authorizations('alice')).length, before + 1)
    })
    await t.test('refresh rotates credentials, detects replay, and survives service recreation', async () => {
      const tokens = await issue()
      service = await createOAuthService(config, db, resolveMcpAuthHash, metadata)
      assert.ok(await service.resolveAccessToken(tokens.access_token))
      const renewed = await refresh(tokens)
      assert.equal(renewed.status, 200, await renewed.clone().text())
      const replacement = await renewed.json()
      assert.notEqual(replacement.refresh_token, tokens.refresh_token)
      assert.equal((await refresh(tokens)).status, 400)
      assert.equal((await call(replacement.access_token)).status, 401)
      const concurrent = await issue()
      const results = await Promise.all([refresh(concurrent), refresh(concurrent)])
      assert.equal(results.filter(r => r.status === 200).length, 1)
    })
    await t.test('scope changes take effect live, and token rotation invalidates access and refresh', async () => {
      const tokens = await issue()
      await db`UPDATE app.mcp_tokens SET tool_names = ${['describe-table']} WHERE id = 'policy-a'`
      assert.deepEqual((await (await call(tokens.access_token)).json()).scope.toolNames, ['describe-table'])
      await db`UPDATE app.mcp_tokens SET token_hash = ${hashMcpToken('wamcp_rotated_secret')} WHERE id = 'policy-a'`
      assert.equal((await call(tokens.access_token)).status, 401)
      assert.equal((await refresh(tokens)).status, 400)
      await db`UPDATE app.mcp_tokens SET token_hash = ${hashMcpToken(native)}, tool_names = ${['list-tables']} WHERE id = 'policy-a'`
    })
    await t.test('token revocation, expiry and membership removal stop both credential types', async () => {
      for (const change of ['revoked', 'expiry', 'membership']) {
        const tokens = await issue()
        if (change === 'revoked') await db`UPDATE app.mcp_tokens SET revoked = true WHERE id = 'policy-a'`
        if (change === 'expiry') await db`UPDATE app.mcp_tokens SET expires_at = now() - interval '1 second' WHERE id = 'policy-a'`
        if (change === 'membership') await db`DELETE FROM app.memberships WHERE user_id = 'alice'`
        assert.equal((await call(tokens.access_token)).status, 401, change)
        assert.equal((await refresh(tokens)).status, 400, change)
        await db`UPDATE app.mcp_tokens SET revoked = false, expires_at = NULL WHERE id = 'policy-a'`
        if (change === 'membership') await db`INSERT INTO app.memberships (org, user_id, role) VALUES ('org-a', 'alice', 'admin')`
      }
    })
    await t.test('members lose OAuth access when their connection assignment is removed', async () => {
      const tokens = await issue('member', 'policy-member')
      await db`DELETE FROM app.instance_assignments WHERE user_id = 'member'`
      assert.equal((await call(tokens.access_token)).status, 401)
      assert.equal((await refresh(tokens)).status, 400)
    })
    await t.test('agent authorizations can be revoked individually without revoking the connector token', async () => {
      const tokens = await issue()
      const access = await service.provider.AccessToken.find(tokens.access_token)
      const row = (await service.authorizations('alice')).find(row => row.id === access.accountId)
      assert.ok(row)
      await service.revoke('bob', row.id)
      assert.equal((await call(tokens.access_token)).status, 200)
      await service.revoke('alice', row.id)
      assert.equal((await call(tokens.access_token)).status, 401)
      assert.equal((await refresh(tokens)).status, 400)
      assert.equal((await call(native)).status, 200)
    })
    await t.test('the standard OAuth revocation endpoint revokes a refresh grant', async () => {
      const tokens = await issue()
      const response = await client.fetch('/oauth/revoke', { method: 'POST', body: new URLSearchParams({
        client_id: gemini.client_id, client_secret: gemini.client_secret,
        token: tokens.refresh_token, token_type_hint: 'refresh_token',
      }) })
      assert.equal(response.status, 200, await response.clone().text())
      assert.equal((await call(tokens.access_token)).status, 401)
      assert.equal((await refresh(tokens)).status, 400)
    })
    await t.test('OAuth token and registration bodies remain bounded after H3 buffering', async () => {
      const response = await client.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(70 * 1024) })
      assert.equal(response.status, 413)
    })
    await t.test('disabling OAuth rejects OAuth credentials and routes while native auth continues', async () => {
      const tokens = await issue()
      values.enabled = false
      assert.equal((await call(tokens.access_token)).status, 401)
      assert.equal((await call(native)).status, 200)
      for (const path of ['/oauth/token', '/oauth/connections', '/.well-known/oauth-protected-resource/mcp']) {
        assert.equal((await client.fetch(path)).status, 404)
      }
      assert.deepEqual(await (await client.fetch('/api/mcp-oauth/status')).json(), { enabled: false })
      values.enabled = true
      assert.equal((await call(tokens.access_token)).status, 200)
    })
    await t.test('expired OAuth access tokens are refused', async () => {
      const tokens = await issue()
      await db`UPDATE mcp_oauth.records SET expires_at = now() - interval '1 second' WHERE model = 'AccessToken' AND id_hash = ${digest(tokens.access_token)}`
      assert.equal((await call(tokens.access_token)).status, 401)
    })
    await t.test('access token audiences and the mcp:use scope are enforced independently', async () => {
      const tokens = await issue()
      const adapter = new (postgresAdapter(db, config.encryptionKey))('AccessToken')
      const payload = await adapter.find(tokens.access_token)
      await adapter.upsert(tokens.access_token, { ...payload, aud: 'https://other.test/mcp' }, 3600)
      assert.equal((await call(tokens.access_token)).status, 401)
      await adapter.upsert(tokens.access_token, { ...payload, scope: 'offline_access' }, 3600)
      const response = await call(tokens.access_token)
      assert.equal(response.status, 403)
      assert.match(response.headers.get('www-authenticate'), /insufficient_scope/)
    })
    await t.test('media download grants retain their existing token-bound revocation behavior', async () => {
      const auth = await resolveMcpAuthHash(hashMcpToken(native))
      const grant = signMediaDownloadGrant({ tokenId: auth.tokenId, jid: 'test@lid', messageId: 'file', sha256: 'a'.repeat(64), expiresAt: Date.now() + 300_000 }, auth.credentialHash)
      assert.ok(await resolveMediaDownloadAuth(grant))
      await db`UPDATE app.mcp_tokens SET revoked = true WHERE id = 'policy-a'`
      assert.equal(await resolveMediaDownloadAuth(grant), undefined)
      await db`UPDATE app.mcp_tokens SET revoked = false WHERE id = 'policy-a'`
    })
    await t.test('adapter outages report 503 instead of invalid credentials', async () => {
      const faultyDb = () => Promise.reject(new Error('simulated PostgreSQL outage'))
      const adapter = new (postgresAdapter(faultyDb, config.encryptionKey))('AccessToken')
      await assert.rejects(adapter.find('test'), error => error.statusCode === 503)
    })
    await t.test('HTTP access and refresh report storage failures as 503', async () => {
      const tokens = await issue()
      await db`ALTER TABLE mcp_oauth.authorizations RENAME TO temporarily_unavailable`
      try {
        assert.equal((await call(tokens.access_token)).status, 503)
        assert.equal((await refresh(tokens)).status, 503)
      }
      finally { await db`ALTER TABLE mcp_oauth.temporarily_unavailable RENAME TO authorizations` }
    })
    await t.test('the production build supports OAuth, MCP tools, login returns and restart toggles', {
      skip: process.env.TEST_OAUTH_BUILD !== 'true' && 'Build first, then set TEST_OAUTH_BUILD=true.',
    }, async () => {
      const entry = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url))
      assert.ok(existsSync(entry), 'run pnpm build first')
      const reservation = createServer()
      await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
      const port = reservation.address().port
      await new Promise(resolve => reservation.close(resolve))
      const previousTransport = transport
      const previousClient = client
      transport = `http://127.0.0.1:${port}`
      client = browser()
      let child
      let output = ''
      async function stop() {
        if (!child || child.exitCode !== null) return
        const processToStop = child
        const exited = new Promise(resolve => processToStop.once('exit', resolve))
        const timer = setTimeout(() => processToStop.kill('SIGKILL'), 5000)
        timer.unref()
        processToStop.kill('SIGTERM')
        await exited
        clearTimeout(timer)
      }
      async function boot(enabled) {
        child = spawn(process.execPath, [entry], { env: {
          ...process.env, NODE_ENV: 'production', NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port),
          NUXT_DATABASE_URL: testUrl.href, NUXT_PUBLIC_APP_URL: origin + '/',
          NUXT_EMAIL_VERIFICATION: 'off', NUXT_CLOUD_URL: '', NUXT_BILLING: '',
          NUXT_MCP_OAUTH_ENABLED: String(enabled), NUXT_MCP_OAUTH_COOKIE_KEY: enabled ? values.cookieKey : '',
          NUXT_MCP_OAUTH_ENCRYPTION_KEY: enabled ? values.encryptionKey : '', NUXT_MCP_OAUTH_JWKS: enabled ? values.jwks : '',
        }, stdio: ['ignore', 'pipe', 'pipe'] })
        const log = chunk => { output = (output + chunk).slice(-16_000) }
        child.stdout.on('data', log)
        child.stderr.on('data', log)
        for (let attempt = 0; attempt < 100; attempt++) {
          if (child.exitCode !== null) assert.fail(`production server exited: ${output}`)
          try {
            const response = await fetch(`${transport}/api/mcp-oauth/status`, { signal: AbortSignal.timeout(1000) })
            if (response.ok && (await response.json()).enabled === enabled) return
          }
          catch { /* the listener is still starting */ }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        assert.fail(`production server did not become ready: ${output}`)
      }
      async function listTools(secret) {
        const response = await client.fetch('/mcp', { method: 'POST', headers: {
          authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
        assert.equal(response.status, 200, `${await response.clone().text()}\n${output}`)
        const text = await response.text()
        const rpc = response.headers.get('content-type').includes('text/event-stream')
          ? JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6)) : JSON.parse(text)
        assert.deepEqual(rpc.result.tools.map(tool => tool.name), ['list-tables'])
      }
      try {
        await boot(true)
        assert.deepEqual(await (await client.fetch('/api/mcp-oauth/status')).json(), { enabled: true, resource: config.resource })
        const discovery = await client.fetch('/.well-known/oauth-authorization-server')
        assert.equal(discovery.status, 200, `${await discovery.clone().text()}\n${output}`)
        const metadata = await discovery.json()
        assert.equal(metadata.issuer, origin)
        assert.ok(metadata.registration_endpoint.endsWith('/oauth/register'))
        const agent = await register('https://oauth-redirect.googleusercontent.com/r/production-test')
        const tokens = await issue('alice', 'policy-a', agent)
        await listTools(tokens.access_token)
        const management = await browser('alice').fetch('/oauth/connections')
        assert.equal(management.status, 200)
        const managementHtml = await management.text()
        assert.match(managementHtml, /Connected agents/)
        assert.match(managementHtml, /← DOPE/)
        assert.match(managementHtml, /PostgreSQL - Primary database/)
        assert.match(managementHtml, /Connector name: Alice policy/)
        const refused = browser('alice')
        const pending = await start(refused, agent)
        const approvalPath = new URL(location(pending.response), origin).pathname
        const consent = await refused.fetch(approvalPath)
        assert.equal(consent.headers.get('referrer-policy'), 'same-origin')
        const consentHtml = await consent.text()
        const invalid = await refused.post(approvalPath, { csrf: 'wrong', decision: 'allow', token: 'policy-a' })
        assert.equal(invalid.status, 403)
        const invalidHtml = await invalid.text()
        assert.match(invalidHtml, /Approval could not be verified/)
        assert.ok(!invalidHtml.includes('__NUXT'), 'approval errors must not hydrate a redacted URL into browser history')
        await db`UPDATE mcp_oauth.records SET expires_at = now() - interval '1 second'
          WHERE model = 'Interaction' AND id_hash = ${digest(approvalPath.split('/').at(-1))}`
        const expired = await refused.post(approvalPath, { csrf: csrf(consentHtml), decision: 'allow', token: 'policy-a' })
        assert.equal(expired.status, 400)
        assert.match(await expired.text(), /Approval is no longer available/)
        const who = browser()
        const started = await start(who, agent)
        const path = new URL(location(started.response), origin).pathname
        const redirect = location(await who.fetch(path))
        assert.equal(redirect, `/login?oauth_return=${encodeURIComponent(path)}`)
        assert.equal((await who.fetch(redirect)).status, 200)
        assert.equal(location(await browser('alice').fetch(redirect)), path)
        await stop()
        await boot(false)
        assert.equal((await call(tokens.access_token)).status, 401)
        assert.equal((await client.fetch('/.well-known/oauth-authorization-server')).status, 404)
        await listTools(native)
        await stop()
        await boot(true)
        await listTools(tokens.access_token)
      }
      finally {
        await stop()
        transport = previousTransport
        client = previousClient
      }
    })
  }
  finally {
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    if (db) await db.end({ timeout: 1 })
    await admin`DROP DATABASE ${admin(database)} WITH (FORCE)`
    await admin.end({ timeout: 1 })
  }
})

function digestBase64(value) { return createHash('sha256').update(value).digest('base64url') }
