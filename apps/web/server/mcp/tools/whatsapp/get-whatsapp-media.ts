import { z } from 'zod'

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'ptvMessage'] as const
const INLINE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * Math.ceil(MAX_MEDIA_BYTES / 3) + 64 * 1024

const mediaResponse = z.object({
  base64: z.string().min(1),
  mimetype: z.string().nullish(),
  fileName: z.string().nullish(),
})

export default defineKindTool({
  name: 'get-whatsapp-media',
  kind: 'whatsapp',
  title: 'Get WhatsApp media',
  description:
    'Download one image, video or voice recording from an in-scope WhatsApp chat. '
    + 'Pass the chat `jid` and the message `id` as `messageId` from read-messages or search-messages. '
    + 'Images and audio are returned as MCP media when supported by their format, '
    + 'and videos are returned as embedded files. Files over 10 MiB are refused. '
    + 'Older attachments may have expired from WhatsApp.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    jid: z.string().min(1).max(256).describe('The full chat JID, exactly as returned by read-messages or search-messages'),
    messageId: z.string().min(1).max(256).describe('The media message ID from read-messages or search-messages'),
  },
  handler: async ({ jid, messageId }) => {
    const { instance, scope } = useMcpAuth()
    assertChatAllowed(scope, jid)
    const { jids } = expandChat(scope, await lidLinks(instance), jid)
    const { records: [record] } = await listMessagesPage(instance, { jids, messageId, limit: 1, page: 1 })
    if (!record?.key) {
      throw createError({ statusCode: 404, message: 'No stored message has this id in the requested chat.' })
    }

    const { payload } = classifyContent(record.message, record.messageType ?? undefined)
    const type = MEDIA_TYPES.find(type => payload?.[type])
    const media = type && payload?.[type]
    if (!type || !media || typeof media !== 'object' || media.viewOnce === true) {
      throw createError({ statusCode: 422, message: 'This message does not have a downloadable image, video or voice recording.' })
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
    const filename = file.fileName || messageId
    const attachment = INLINE_IMAGE.has(mimeType)
      ? { type: 'image' as const, data: file.base64, mimeType }
      : mimeType.startsWith('audio/')
        ? { type: 'audio' as const, data: file.base64, mimeType }
        : {
            type: 'resource' as const,
            resource: {
              uri: `whatsapp-media:///${encodeURIComponent(jid)}/${encodeURIComponent(messageId)}`,
              mimeType,
              blob: file.base64,
            },
          }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ jid, messageId, filename, mimeType, size: data.length }) },
        attachment,
      ],
    }
  },
})

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
