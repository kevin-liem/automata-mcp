import { z } from 'zod'
import { createHash } from 'node:crypto'

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'ptvMessage', 'documentMessage', 'stickerMessage'] as const
const INLINE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * Math.ceil(MAX_MEDIA_BYTES / 3) + 64 * 1024
const DEFAULT_CHUNK_BYTES = 12 * 1024
const MAX_CHUNK_BYTES = 48 * 1024

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
    'Download one image, video, audio recording, document or sticker from an in-scope WhatsApp chat. '
    + 'Copy the chat `jid` and exact message `id` as `messageId` from read-messages or search-messages; do not infer an ID from a timestamp. '
    + 'Images and audio are returned as MCP media when supported by their format, '
    + 'and other formats are returned as embedded files with their original bytes and MIME type. '
    + 'Files over 10 MiB are refused. '
    + 'If the client omits audio or cannot receive media blocks, use `delivery: "base64"`: '
    + 'it returns the actual file bytes as a bounded base64 chunk in JSON text, with metadata and a SHA-256 checksum. '
    + 'Repeat with `nextOffset` until `hasMore` is false, decode each chunk separately, then concatenate the decoded bytes to save the file. '
    + '`delivery: "file"` returns an embedded file instead of native image/audio. Downloading audio does not transcribe it. '
    + 'Older attachments may have expired from WhatsApp.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    jid: z.string().min(1).max(256).describe('The full chat JID, exactly as returned by read-messages or search-messages'),
    messageId: z.string().min(1).max(256).describe('Copy the exact id from the desired media entry in read-messages or search-messages'),
    delivery: z.enum(['native', 'file', 'base64']).default('native').describe('native: MCP image/audio or embedded file; file: always an embedded file; base64: JSON text chunks for clients that omit media blocks'),
    offset: z.number().int().min(0).max(MAX_MEDIA_BYTES).default(0).describe('For base64 delivery only: decoded byte offset, starting at 0; use nextOffset to continue'),
    limit: z.number().int().min(1).max(MAX_CHUNK_BYTES).default(DEFAULT_CHUNK_BYTES).describe('For base64 delivery only: maximum decoded bytes in this chunk, default 12 KiB and maximum 48 KiB'),
  },
  handler: async ({ jid, messageId, delivery = 'native', offset = 0, limit = DEFAULT_CHUNK_BYTES }) => {
    const { instance, scope } = useMcpAuth()
    assertChatAllowed(scope, jid)
    if (delivery !== 'base64' && (offset !== 0 || limit !== DEFAULT_CHUNK_BYTES)) {
      throw createError({ statusCode: 400, message: 'offset and limit apply only to delivery: "base64".' })
    }
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
    const meta = { jid, messageId, filename, mimeType, size: data.length, delivery, sha256: createHash('sha256').update(data).digest('hex') }

    // Some ChatGPT clients replace native audio with an "audio content omitted"
    // placeholder. Text delivery must work without any multimodal content block.
    if (delivery === 'base64') {
      if (offset >= data.length) {
        throw createError({ statusCode: 416, message: 'The byte offset is outside this file. Start at 0 or use the previous response\'s nextOffset.' })
      }
      const chunk = data.subarray(offset, offset + limit)
      const nextOffset = offset + chunk.length
      const hasMore = nextOffset < data.length
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ...meta, encoding: 'base64', offset, byteLength: chunk.length, hasMore,
          ...(hasMore && { nextOffset }), data: chunk.toString('base64'),
        }) }],
      }
    }

    const attachment = delivery === 'native' && INLINE_IMAGE.has(mimeType)
      ? { type: 'image' as const, data: file.base64, mimeType }
      : delivery === 'native' && mimeType.startsWith('audio/')
        ? { type: 'audio' as const, data: file.base64, mimeType }
        : {
            type: 'resource' as const,
            resource: {
              uri: `whatsapp-media:///${encodeURIComponent(jid)}/${encodeURIComponent(messageId)}/${encodeURIComponent(filename)}`,
              mimeType,
              blob: file.base64,
            },
          }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({
          ...meta,
          ...(mimeType.startsWith('audio/') && {
            note: 'The audio file was downloaded; no transcript is included. If your client omits the audio/file block, call this tool with delivery: "base64" and offset: 0, then page with nextOffset until hasMore is false. Decode each chunk separately and concatenate the decoded bytes to save the file.',
          }),
        }) },
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
