import { z } from 'zod'
import type { McpAuth } from './mcp-auth'

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'ptvMessage', 'documentMessage', 'stickerMessage'] as const
export const WHATSAPP_MEDIA_MAX_BYTES = 10 * 1024 * 1024
const MAX_MEDIA_BYTES = WHATSAPP_MEDIA_MAX_BYTES
const MAX_RESPONSE_BYTES = 4 * Math.ceil(MAX_MEDIA_BYTES / 3) + 64 * 1024

const mediaResponse = z.object({
  base64: z.string().min(1),
  mimetype: z.string().nullish(),
  fileName: z.string().nullish(),
})

export async function fetchWhatsAppMedia(auth: McpAuth, jid: string, messageId: string) {
  const { instance, scope } = auth
  assertChatAllowed(scope, jid)
  const { jids } = expandChat(scope, await lidLinks(instance), jid)
  const { records: [record] } = await listMessagesPage(instance, { jids, messageId, limit: 1, page: 1 })
  if (!record?.key) {
    throw createError({ statusCode: 404, message: 'No stored message has this id in the requested chat. Copy the exact id from read-messages or search-messages.' })
  }

  const { payload, type: messageType } = classifyContent(record.message, record.messageType ?? undefined)
  const type = MEDIA_TYPES.find(type => payload?.[type])
  const media = type && payload?.[type]
  if (!type || !media || typeof media !== 'object') {
    throw createError({ statusCode: 422, message: `The requested message is ${messageType || record.messageType || 'a non-media message'}, not downloadable media. Copy the exact id of the desired media entry from read-messages or search-messages; [voice message] is an audio placeholder, not a transcript.` })
  }
  if (media.viewOnce === true) {
    throw createError({ statusCode: 422, message: 'This is view-once media, which this connector does not download.' })
  }
  if (fileLength(media.fileLength) > MAX_MEDIA_BYTES) throw mediaTooLarge()

  // Evolution's ID-only lookup ignores the chat JID. Supply the exact scoped
  // payload, unwrapped as in read-messages so album items work too.
  const response = await useEvolutionClient().raw(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance.name)}`, {
    method: 'POST',
    body: { message: { key: record.key, message: { [type]: media } } },
    responseType: 'stream',
    ignoreResponseError: true,
  }).catch(() => {
    throw createError({ statusCode: 503, message: 'The WhatsApp server could not be reached to download this attachment.' })
  })

  const file = await readMediaResponse(response)
  const data = Buffer.from(file.base64, 'base64')
  if (data.length > MAX_MEDIA_BYTES) throw mediaTooLarge()
  if (!data.length || data.toString('base64') !== file.base64) throw invalidMediaResponse()

  const reportedType = file.mimetype || (typeof media.mimetype === 'string' ? media.mimetype : '')
  const mimeType = reportedType.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream'
  const filename = file.fileName || (typeof media.fileName === 'string' && media.fileName) || messageId
  return { data, base64: file.base64, filename, mimeType }
}

/** Evolution can store protobuf lengths as numbers, decimal strings or Long objects. */
function fileLength(value: unknown): number {
  if (typeof value === 'number' || typeof value === 'string') return Number(value)
  if (value && typeof value === 'object'
    && 'low' in value && typeof value.low === 'number'
    && 'high' in value && typeof value.high === 'number') {
    return (value.high >>> 0) * 2 ** 32 + (value.low >>> 0)
  }
  return 0
}

/** Bound the response before buffering it, even if the stored size is missing. */
async function readMediaResponse(response: Response) {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {})
    if (response.status === 400 || response.status === 404) {
      throw createError({ statusCode: 404, message: 'WhatsApp could not download this attachment. It may have expired.' })
    }
    throw invalidMediaResponse()
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw mediaTooLarge()
      chunks.push(value)
    }
    return mediaResponse.parse(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')))
  }
  catch (error) {
    if (httpStatusOf(error) === 413) throw error
    throw invalidMediaResponse()
  }
  finally {
    void reader.cancel().catch(() => {})
  }
}

function mediaTooLarge() {
  return createError({ statusCode: 413, message: 'This WhatsApp attachment is larger than the 10 MiB download limit.' })
}

function invalidMediaResponse() {
  return createError({ statusCode: 502, message: 'The WhatsApp server returned an unreadable attachment response.' })
}
