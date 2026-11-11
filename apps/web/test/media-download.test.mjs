import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'
import {
  MEDIA_DOWNLOAD_TTL_MS, parseMediaDownloadGrant, signMediaDownloadGrant, verifyMediaDownloadGrant,
} from '../server/utils/media-download-grant.ts'
import { isMediaDownloadPath, redactPath } from '../server/utils/redact.ts'

// Resolve the two Nuxt aliases needed by the actual auth module under Node.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '#shared/connection') return next(new URL('../shared/connection.ts', import.meta.url).href, context)
  if (specifier === './media-download-grant') return next(new URL('../server/utils/media-download-grant.ts', import.meta.url).href, context)
  return next(specifier, context)
} })
const { hashMcpToken, resolveMcpAuth, resolveMediaDownloadAuth } = await import('../server/utils/mcp-auth.ts')
const { createWhatsAppMediaDownload } = await import('../server/utils/whatsapp-media-download.ts')

const rawToken = 'wamcp_test_only_original_bearer_credential'
const jid = '123456789@lid'
const messageId = 'VOICE-1'
const original = Buffer.from('OggS synthetic test bytes\x00\xff', 'latin1')
const sha256 = createHash('sha256').update(original).digest('hex')
let record, instance, file, downloads, refusal, publicUrl

const sql = async (strings, ...values) => {
  const query = strings.join('?')
  if (query.includes('SELECT token_hash FROM app.mcp_tokens')) {
    return record && record.id === values[0] && (!query.includes('revoked = false') || !record.revoked)
      ? [{ token_hash: record.token_hash }] : []
  }
  if (query.includes('FROM app.mcp_tokens t')) return record?.token_hash === values[0] ? [record] : []
  if (query.includes('UPDATE app.mcp_tokens')) return []
  throw new Error('Unexpected auth query')
}

Object.assign(globalThis, {
  appDb: async () => sql,
  getRow: async () => instance,
  appDbUnavailable: error => error,
  instanceKind: value => value.kind,
  authorizesInstance: (member, org, assigned) => member.orgId === org && (member.role === 'admin' || assigned),
  credentialsForInstance: value => ({ baseUrl: value.base_url, apiKey: value.api_key }),
  scopeFromRecord: value => ({ allChats: value.all_chats, chatJids: value.chat_jids, allTools: value.all_tools, toolNames: value.tool_names }),
  getRequestHeader: (event, name) => event.headers?.[name],
  getRouterParam: (event, name) => event.params?.[name],
  useRuntimeConfig: () => ({ public: { appUrl: publicUrl } }),
  createError: ({ statusCode, message }) => Object.assign(new Error(message), { statusCode }),
  resolveMediaDownloadAuth,
  defineEventHandler: handler => handler,
  isToolAllowed: (event, tool, kind) => event.context.mcpAuth.kind === kind
    && (event.context.mcpAuth.scope.allTools || event.context.mcpAuth.scope.toolNames.includes(tool)),
  mcpLimitRefusal: async () => refusal,
  fetchWhatsAppMedia: async (auth, requestedJid, requestedId) => {
    if (!auth.scope.allChats && !auth.scope.chatJids.includes(requestedJid)) {
      throw Object.assign(new Error('Chat outside scope'), { statusCode: 403 })
    }
    assert.equal(requestedJid, jid)
    assert.equal(requestedId, messageId)
    downloads++
    return file
  },
  setHeader: (event, name, value) => event.responseHeaders.set(name.toLowerCase(), String(value)),
  send: (_event, data) => data,
})
const { default: download } = await import('../server/api/media/whatsapp/[grant].get.ts')

beforeEach(() => {
  record = {
    id: 'token-1', assigned_to: 'owner-1', instance: 'connection-1', token_hash: hashMcpToken(rawToken),
    revoked: false, user_email: 'owner@example.test', member_role: 'admin', member_org: 'org-1', assigned: false,
    all_chats: false, chat_jids: [jid], all_tools: false, tool_names: ['get-whatsapp-media'],
  }
  instance = { id: 'connection-1', org: 'org-1', kind: 'whatsapp', base_url: 'https://evolution.example', api_key: 'private-test-key' }
  file = { data: original, filename: 'voice 日本語.oga', mimeType: 'audio/ogg' }
  downloads = 0
  refusal = undefined
  publicUrl = 'https://automata.example'
})

function claims(expiresAt = Date.now() + MEDIA_DOWNLOAD_TTL_MS) {
  return { tokenId: record.id, jid, messageId, sha256, expiresAt }
}
function grant() { return signMediaDownloadGrant(claims(), record.token_hash) }
function event(value = grant()) { return { context: {}, params: { grant: value }, responseHeaders: new Map() } }

test('a file grant binds the token, chat, message, checksum and short expiry', () => {
  const now = 1_000_000
  const value = claims(now + MEDIA_DOWNLOAD_TTL_MS)
  const signed = signMediaDownloadGrant(value, record.token_hash)
  assert.deepEqual(verifyMediaDownloadGrant(signed, record.token_hash, now), value)
  assert.equal(verifyMediaDownloadGrant(signed, record.token_hash, value.expiresAt), undefined)
  assert.equal(verifyMediaDownloadGrant(signed, 'f'.repeat(64), now), undefined)
  for (const field of ['tokenId', 'jid', 'messageId', 'sha256', 'expiresAt']) {
    const changed = { ...value, [field]: field === 'expiresAt' ? value.expiresAt - 1 : field === 'sha256' ? 'f'.repeat(64) : 'other' }
    const payload = Buffer.from(JSON.stringify(changed)).toString('base64url')
    assert.equal(verifyMediaDownloadGrant(`${payload}.${signed.split('.')[1]}`, record.token_hash, now), undefined)
  }
  const tooLong = signMediaDownloadGrant(claims(now + MEDIA_DOWNLOAD_TTL_MS + 1), record.token_hash)
  assert.equal(verifyMediaDownloadGrant(tooLong, record.token_hash, now), undefined)
  for (const invalid of ['', 'x.y', 'x.y.z', 'a'.repeat(2049), `${signed}=`, signed + '.']) {
    assert.equal(verifyMediaDownloadGrant(invalid, record.token_hash, now), undefined)
  }
})

test('link creation does not expose the original bearer and uses the configured public origin', async () => {
  const { auth } = await resolveMediaDownloadAuth(grant())
  const result = await createWhatsAppMediaDownload(auth, jid, messageId, sha256)
  assert.equal(new URL(result.downloadUrl).origin, publicUrl)
  assert.ok(!result.downloadUrl.includes(rawToken))
  const encoded = new URL(result.downloadUrl).pathname.split('/').pop()
  assert.equal(parseMediaDownloadGrant(encoded).messageId, messageId)
  assert.equal(parseMediaDownloadGrant(encoded).sha256, sha256)
  assert.ok(Date.parse(result.downloadExpiresAt) > Date.now())
  publicUrl = ''
  await assert.rejects(createWhatsAppMediaDownload(auth, jid, messageId, sha256), { statusCode: 503 })
  publicUrl = 'http://public.example'
  await assert.rejects(createWhatsAppMediaDownload(auth, jid, messageId, sha256), { statusCode: 503 })
  publicUrl = 'https://user:secret@automata.example'
  await assert.rejects(createWhatsAppMediaDownload(auth, jid, messageId, sha256), { statusCode: 503 })
})

test('a valid link downloads the original file without an MCP bearer or browser session', async () => {
  const request = event()
  assert.deepEqual(await download(request), original)
  assert.equal(downloads, 1)
  assert.equal(request.responseHeaders.get('content-type'), 'audio/ogg')
  assert.equal(request.responseHeaders.get('content-length'), String(original.length))
  assert.match(request.responseHeaders.get('content-disposition'), /filename\*=UTF-8''voice%20/)
  assert.equal(request.responseHeaders.get('cache-control'), 'no-store')
  assert.equal(request.responseHeaders.get('x-content-type-options'), 'nosniff')
})

test('download grants use the same live account authorization as ordinary MCP requests', async () => {
  const normal = await resolveMcpAuth({ headers: { authorization: `Bearer ${rawToken}` } })
  const linked = await resolveMediaDownloadAuth(grant())
  assert.deepEqual(linked.auth, normal)
  const signed = grant()
  record.member_org = 'other-org'
  assert.equal(await resolveMediaDownloadAuth(signed), undefined)
})

test('revoked, expired, rotated or deleted tokens invalidate a previously issued link', async () => {
  const signed = grant()
  record.revoked = true
  assert.equal(await resolveMediaDownloadAuth(signed), undefined)
  record.revoked = false
  record.expires_at = new Date(Date.now() - 1000).toISOString()
  assert.equal(await resolveMediaDownloadAuth(signed), undefined)
  delete record.expires_at
  record.token_hash = 'f'.repeat(64)
  assert.equal(await resolveMediaDownloadAuth(signed), undefined)
  record = undefined
  assert.equal(await resolveMediaDownloadAuth(signed), undefined)
  assert.equal(downloads, 0)
})

test('removing the tool or chat from scope prevents a previously issued download', async () => {
  const signed = grant()
  record.tool_names = []
  await assert.rejects(download(event(signed)), { statusCode: 403 })
  record.tool_names = ['get-whatsapp-media']
  record.chat_jids = []
  await assert.rejects(download(event(signed)), { statusCode: 403 })
  assert.equal(downloads, 0)
})

test('invalid and expired grants are refused before fetching media', async () => {
  await assert.rejects(download(event('invalid')), { statusCode: 404 })
  const expired = signMediaDownloadGrant(claims(Date.now() - 1000), record.token_hash)
  await assert.rejects(download(event(expired)), { statusCode: 404 })
  assert.equal(downloads, 0)
})

test('changed attachments and plan limits cannot turn a grant into a different download', async () => {
  const signed = grant()
  refusal = new Response('over limit', { status: 403 })
  assert.equal((await download(event(signed))).status, 403)
  assert.equal(downloads, 0)
  refusal = undefined
  file.data = Buffer.from('changed file')
  await assert.rejects(download(event(signed)), { statusCode: 409 })
})

test('capability URLs are redacted from paths used by the server error handler', () => {
  const path = `/api/media/whatsapp/${grant()}`
  assert.equal(isMediaDownloadPath(path), true)
  assert.equal(redactPath(path), '/api/media/whatsapp/[redacted]')
  assert.equal(redactPath('/mcp/secret'), '/mcp/[redacted]')
  assert.equal(redactPath('/api/hosted'), '/api/hosted')
})
