import assert from 'node:assert/strict'
import { test } from 'node:test'

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

Object.assign(globalThis, {
  defineKindTool: definition => definition,
  useMcpAuth: () => ({ instance, scope }),
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

function prepare(type = 'imageMessage', mimeType = 'image/png', data = Buffer.from([0, 255, 128, 1])) {
  const media = { mimetype: mimeType, fileLength: data.length }
  record = { key, messageType: type, message: { [type]: media } }
  response = () => Response.json({ base64: data.toString('base64'), mimetype: mimeType, fileName: 'sample.bin' })
  downloads = []
  lookup = undefined
  return { media, data }
}

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
    const result = await tool.handler({ jid, messageId })
    const mimeType = reportedType.split(';')[0]
    assert.deepEqual(JSON.parse(result.content[0].text), {
      jid, messageId, filename: 'sample.bin', mimeType, size: data.length,
    })
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
  const result = await tool.handler({ jid, messageId })
  assert.equal(JSON.parse(result.content[0].text).filename, media.fileName)
  assert.equal(result.content[1].resource.mimeType, 'application/pdf')
  assert.ok(result.content[1].resource.uri.endsWith(`/${encodeURIComponent(media.fileName)}`))
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
  const result = await tool.handler({ jid, messageId })
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
