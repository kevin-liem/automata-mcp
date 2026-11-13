import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fetchWhatsAppMedia, WHATSAPP_MEDIA_MAX_BYTES } from '../server/utils/whatsapp-media.ts'

// Use the SDK version that the production toolkit registers tools with.
const toolkitRequire = createRequire(import.meta.resolve('@nuxtjs/mcp-toolkit'))
const { McpServer } = toolkitRequire('@modelcontextprotocol/sdk/server/mcp.js')
const { Client } = toolkitRequire('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = toolkitRequire('@modelcontextprotocol/sdk/inMemory.js')

registerHooks({ resolve(specifier, context, next) {
  if (specifier === './tool-calls') return next(new URL('../server/utils/tool-calls.ts', import.meta.url).href, context)
  return next(specifier, context)
} })
const { defineKindTool } = await import('../server/utils/mcp-kind-tool.ts')

// Nuxt supplies these auto-imports in production. Keep the tool itself intact
// and replace only its authenticated database and Evolution boundaries here.
const instance = { name: 'media-instance' }
const scope = { allChats: true }
const jid = '123456789@lid'
const messageId = 'MEDIA-1'
const key = { id: messageId, remoteJid: jid, fromMe: false }
const maxBytes = 10 * 1024 * 1024
let record
let response
let downloads
let lookup
let links

Object.assign(globalThis, {
  defineKindTool,
  defineMcpTool: definition => definition,
  useMcpAuth: () => ({ instance, scope, tokenId: 'media-token', kind: 'whatsapp' }),
  fetchWhatsAppMedia,
  WHATSAPP_MEDIA_MAX_BYTES,
  createWhatsAppMediaDownload: async (auth, requestedJid, requestedId, sha256) => {
    links.push({ tokenId: auth.tokenId, jid: requestedJid, messageId: requestedId, sha256 })
    return { downloadUrl: 'https://automata.example/api/media/whatsapp/file-only-grant', downloadExpiresAt: '2030-01-01T00:05:00.000Z' }
  },
  assertChatAllowed: (_scope, requested) => {
    if (requested !== jid) throw Object.assign(new Error('Chat outside scope'), { statusCode: 403 })
  },
  lidLinks: async () => new Map(),
  expandChat: (_scope, _links, requested) => ({ jids: [requested] }),
  listMessagesPage: async (requestedInstance, options) => {
    assert.equal(requestedInstance, instance)
    lookup = options
    return { records: record ? [record] : [] }
  },
  classifyContent: message => ({ payload: message }),
  useEvolutionClient: () => ({ raw: async (path, options) => {
    downloads.push({ path, options })
    return response()
  } }),
  createError: ({ statusCode, message }) => Object.assign(new Error(message), { statusCode }),
  httpStatusOf: error => error?.statusCode,
})
const { default: tool } = await import('../server/mcp/tools/whatsapp/get-whatsapp-media.ts')

async function mediaClient(t) {
  const server = new McpServer({ name: 'whatsapp-media-test', version: '1' })
  server.registerTool(tool.name, {
    title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }, tool.handler)
  const client = new Client({ name: 'media-test-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  t.after(async () => { await client.close(); await server.close() })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

function prepare(type = 'imageMessage', mimeType = 'image/png', data = Buffer.from([0, 255, 128, 1])) {
  const media = { mimetype: mimeType, fileLength: data.length }
  record = { key, messageType: type, message: { [type]: media } }
  response = () => Response.json({ base64: data.toString('base64'), mimetype: mimeType, fileName: 'sample.bin' })
  downloads = []
  lookup = undefined
  links = []
  return { media, data }
}

test('tools/list exposes every optional delivery mode and chunk control to MCP clients', async t => {
  const client = await mediaClient(t)
  const { tools } = await client.listTools()
  const listed = tools.find(value => value.name === tool.name)
  assert.ok(listed)
  const { properties, required } = listed.inputSchema
  assert.deepEqual(properties.delivery.enum, ['auto', 'native', 'file', 'base64'])
  assert.equal(properties.delivery.default, 'auto')
  assert.equal(properties.offset.default, 0)
  assert.equal(properties.offset.maximum, WHATSAPP_MEDIA_MAX_BYTES)
  assert.equal(properties.limit.default, 12 * 1024)
  assert.equal(properties.limit.maximum, 48 * 1024)
  assert.deepEqual(required, ['jid', 'messageId'])
  assert.ok(properties.reason)

  const manifest = JSON.parse(readFileSync(new URL('../../../lhm.plugin.json', import.meta.url), 'utf8'))
  const published = manifest.tools.find(value => value.name === tool.name)
  assert.equal(published.description, `[WhatsApp] ${listed.description}`)
  for (const field of ['delivery', 'offset', 'limit']) {
    assert.deepEqual(published.inputSchema.properties[field], properties[field])
  }
})

test('an MCP client can select native audio from discovery while omitted delivery keeps download links', async t => {
  const { data } = prepare('audioMessage', 'audio/ogg; codecs=opus')
  const client = await mediaClient(t)
  const native = await client.callTool({ name: tool.name, arguments: { jid, messageId, delivery: 'native' } })
  assert.ok(!native.isError)
  assert.equal(native.content[1].type, 'audio')
  assert.deepEqual(Buffer.from(native.content[1].data, 'base64'), data)
  assert.equal(JSON.parse(native.content[0].text).delivery, 'native')
  assert.equal(links.length, 0)

  const automatic = await client.callTool({ name: tool.name, arguments: { jid, messageId } })
  assert.ok(!automatic.isError)
  assert.equal(automatic.content[1].type, 'resource_link')
  assert.equal(JSON.parse(automatic.content[0].text).delivery, 'auto')

  const before = downloads.length
  const invalid = await client.callTool({ name: tool.name, arguments: { jid, messageId, delivery: 'unsupported' } })
  assert.equal(invalid.isError, true)
  assert.equal(downloads.length, before)
})

const formats = [
  ['imageMessage', 'image/png', 'image'],
  ['imageMessage', 'image/jpeg', 'image'],
  ['imageMessage', 'image/gif', 'image'],
  ['imageMessage', 'image/webp', 'image'],
  ['stickerMessage', 'image/webp', 'image'],
  ['audioMessage', 'audio/ogg; codecs=opus', 'audio'],
  ['audioMessage', 'audio/mpeg', 'audio'],
  ['audioMessage', 'audio/wav', 'audio'],
  ['audioMessage', 'audio/mp4', 'audio'],
  ['videoMessage', 'video/mp4', 'resource'],
  ['ptvMessage', 'video/mp4', 'resource'],
  ['documentMessage', 'application/pdf', 'resource'],
  ['documentMessage', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'resource'],
  ['documentMessage', 'text/plain', 'resource'],
  ['documentMessage', 'application/octet-stream', 'resource'],
  ['imageMessage', 'image/heic', 'resource'],
]

for (const [type, reportedType, contentType] of formats) {
  test(`${type} (${reportedType}) preserves bytes as MCP ${contentType}`, async () => {
    const { media, data } = prepare(type, reportedType)
    const result = await tool.handler({ jid, messageId, delivery: 'native' })
    const mimeType = reportedType.split(';')[0]
    const { note, ...metadata } = JSON.parse(result.content[0].text)
    assert.deepEqual(metadata, {
      jid, messageId, filename: 'sample.bin', mimeType, size: data.length, delivery: 'native',
      sha256: createHash('sha256').update(data).digest('hex'),
    })
    if (contentType === 'audio') assert.match(note, /delivery: "base64"/)
    const attachment = result.content[1]
    assert.equal(attachment.type, contentType)
    const file = contentType === 'resource' ? attachment.resource : attachment
    assert.equal(file.mimeType, mimeType)
    assert.deepEqual(Buffer.from(file.blob ?? file.data, 'base64'), data)
    if (contentType === 'resource') assert.match(file.uri, /\/sample\.bin$/)
    assert.deepEqual(lookup, { jids: [jid], messageId, limit: 1, page: 1 })
    assert.equal(downloads[0].path, '/chat/getBase64FromMediaMessage/media-instance')
    assert.deepEqual(downloads[0].options.body, { message: { key, message: { [type]: media } } })
  })
}

test('uses the stored document filename and MIME type when Evolution omits them', async () => {
  const { media, data } = prepare('documentMessage', 'application/pdf')
  media.fileName = 'invoice #1 日本語.pdf'
  response = () => Response.json({ base64: data.toString('base64') })
  const result = await tool.handler({ jid, messageId, delivery: 'native' })
  assert.equal(JSON.parse(result.content[0].text).filename, media.fileName)
  assert.equal(result.content[1].resource.mimeType, 'application/pdf')
  assert.ok(result.content[1].resource.uri.endsWith(`/${encodeURIComponent(media.fileName)}`))
})

test('file delivery returns audio as an embedded file with its original bytes', async () => {
  const { data } = prepare('audioMessage', 'audio/ogg; codecs=opus')
  const result = await tool.handler({ jid, messageId, delivery: 'file' })
  assert.equal(result.content[1].type, 'resource')
  assert.equal(result.content[1].resource.mimeType, 'audio/ogg')
  assert.deepEqual(Buffer.from(result.content[1].resource.blob, 'base64'), data)
  assert.equal(JSON.parse(result.content[0].text).delivery, 'file')
})

test('ordinary voice-note retrieval needs only jid and messageId and returns a download link', async () => {
  const { data } = prepare('audioMessage', 'audio/ogg; codecs=opus', Buffer.alloc(178_011, 0xa5))
  const result = await tool.handler({ jid, messageId })
  const meta = JSON.parse(result.content[0].text)
  assert.equal(meta.delivery, 'auto')
  assert.equal(meta.size, data.length)
  assert.equal(meta.mimeType, 'audio/ogg')
  assert.equal(meta.downloadUrl, 'https://automata.example/api/media/whatsapp/file-only-grant')
  assert.ok(meta.downloadExpiresAt)
  assert.match(meta.note, /clickable download link/)
  assert.equal(result.content[1].type, 'resource_link')
  assert.equal(result.content[1].uri, meta.downloadUrl)
  assert.equal(result.content[1].name, meta.filename)
  assert.equal(downloads.length, 1)
  assert.deepEqual(links, [{ tokenId: 'media-token', jid, messageId, sha256: meta.sha256 }])
  assert.ok(result.content.every(block => !('data' in block)))
})

test('ordinary image requests retain their inline preview and include a download link', async () => {
  const { data } = prepare()
  const result = await tool.handler({ jid, messageId })
  assert.equal(result.content[1].type, 'image')
  assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), data)
  assert.match(JSON.parse(result.content[0].text).downloadUrl, /^https:/)
})

test('a client that discards native audio can reconstruct the voice file using text-only chunks', async () => {
  const data = Buffer.alloc(178_011)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  prepare('audioMessage', 'audio/ogg; codecs=opus', data)
  // Reproduce the host behavior: only text survives a native audio response.
  const native = await tool.handler({ jid, messageId, delivery: 'native' })
  const visible = native.content.filter(block => block.type === 'text')
  assert.equal(visible.length, 1)
  assert.match(JSON.parse(visible[0].text).note, /no transcript/)

  const chunks = []
  let offset = 0
  let expectedHash
  for (;;) {
    const result = await tool.handler({ jid, messageId, delivery: 'base64', offset })
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'text')
    const part = JSON.parse(result.content[0].text)
    assert.equal(part.offset, offset)
    assert.equal(part.encoding, 'base64')
    assert.equal(part.delivery, 'base64')
    assert.equal(part.size, data.length)
    assert.equal(part.mimeType, 'audio/ogg')
    assert.ok(part.byteLength <= 12 * 1024)
    const bytes = Buffer.from(part.data, 'base64')
    assert.equal(bytes.length, part.byteLength)
    chunks.push(bytes)
    expectedHash ??= part.sha256
    assert.equal(part.sha256, expectedHash)
    if (!part.hasMore) {
      assert.equal(part.nextOffset, undefined)
      break
    }
    assert.equal(part.nextOffset, offset + bytes.length)
    offset = part.nextOffset
  }
  const received = Buffer.concat(chunks)
  assert.deepEqual(received, data)
  assert.equal(createHash('sha256').update(received).digest('hex'), expectedHash)
})

test('chunk offsets refer to decoded bytes, including padded base64 chunks', async () => {
  const { data } = prepare('documentMessage', 'application/octet-stream', Buffer.from([0, 255, 1, 128, 2]))
  const parts = []
  for (let offset = 0; offset < data.length; offset += 2) {
    const result = await tool.handler({ jid, messageId, delivery: 'base64', offset, limit: 2 })
    const part = JSON.parse(result.content[0].text)
    assert.equal(part.offset, offset)
    parts.push(Buffer.from(part.data, 'base64'))
  }
  assert.deepEqual(Buffer.concat(parts), data)
  await assert.rejects(tool.handler({ jid, messageId, delivery: 'base64', offset: data.length }), { statusCode: 416 })
})

test('a wrong non-media message id gives recovery instructions instead of suggesting an expired recording', async () => {
  prepare()
  record = { key, messageType: 'conversation', message: { conversation: 'plain text' } }
  await assert.rejects(tool.handler({ jid, messageId }), error => {
    assert.equal(error.statusCode, 422)
    assert.match(error.message, /conversation, not downloadable media/)
    assert.match(error.message, /Copy the exact id/)
    assert.doesNotMatch(error.message, /expired/)
    return true
  })
  assert.equal(downloads.length, 0)
})

test('base64 fallback keeps chat scope, view-once restrictions and the original file-size limit', async () => {
  const { media } = prepare('audioMessage', 'audio/ogg')
  await assert.rejects(tool.handler({ jid: 'other@lid', messageId, delivery: 'base64' }), { statusCode: 403 })
  media.viewOnce = true
  await assert.rejects(tool.handler({ jid, messageId, delivery: 'base64' }), /view-once media/)
  delete media.viewOnce
  media.fileLength = maxBytes + 1
  await assert.rejects(tool.handler({ jid, messageId, delivery: 'base64' }), { statusCode: 413 })
  assert.equal(downloads.length, 0)
})

test('chunk controls are refused for native delivery before a download', async () => {
  prepare()
  await assert.rejects(tool.handler({ jid, messageId, offset: 1 }), { statusCode: 400 })
  assert.equal(downloads.length, 0)
})

test('refuses an out-of-scope chat before querying or downloading', async () => {
  prepare()
  await assert.rejects(tool.handler({ jid: 'other@lid', messageId }), { statusCode: 403 })
  assert.equal(lookup, undefined)
  assert.equal(downloads.length, 0)
})

test('refuses a missing message and view-once or non-media messages before downloading', async () => {
  prepare()
  record = undefined
  await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 404 })
  for (const message of [{ imageMessage: { viewOnce: true } }, { conversation: 'text' }]) {
    record = { key, message }
    await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 422 })
  }
  assert.equal(downloads.length, 0)
})

test('refuses all supported representations of an oversized stored length before downloading', async () => {
  for (const length of [maxBytes + 1, String(maxBytes + 1), { low: maxBytes + 1, high: 0 }, { low: 0, high: 1 }]) {
    const { media } = prepare()
    media.fileLength = length
    await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 413 })
    assert.equal(downloads.length, 0)
  }
})

test('accepts exactly 10 MiB and refuses oversized decoded bytes even without a stored size', async () => {
  const data = Buffer.alloc(maxBytes, 0xa5)
  prepare('documentMessage', 'application/octet-stream', data)
  const result = await tool.handler({ jid, messageId, delivery: 'native' })
  assert.equal(JSON.parse(result.content[0].text).size, maxBytes)
  assert.deepEqual(Buffer.from(result.content[1].resource.blob, 'base64'), data)
  const { media } = prepare('documentMessage', 'application/octet-stream', Buffer.alloc(maxBytes + 1))
  delete media.fileLength
  await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 413 })
})

test('caps the streamed Evolution response before buffering it completely', async () => {
  prepare()
  let cancelled = false
  response = () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled = true },
  }))
  await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 413 })
  assert.equal(cancelled, true)
})

test('reports expired media and malformed upstream results without returning partial files', async () => {
  prepare()
  for (const status of [400, 404]) {
    response = () => new Response('expired', { status })
    await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 404 })
  }
  for (const body of ['not JSON', '{}', '{"base64":"%%%"}', '{"base64":"data:image/png;base64,YQ=="}']) {
    response = () => new Response(body)
    await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 502 })
  }
  response = () => { throw new Error('unreachable') }
  await assert.rejects(tool.handler({ jid, messageId }), { statusCode: 503 })
})
