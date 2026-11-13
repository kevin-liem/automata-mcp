import { z } from 'zod'
import { createHash } from 'node:crypto'

const INLINE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const DEFAULT_CHUNK_BYTES = 12 * 1024
const MAX_CHUNK_BYTES = 48 * 1024

export default defineKindTool({
  name: 'get-whatsapp-media',
  kind: 'whatsapp',
  title: 'Get WhatsApp media',
  description:
    'Download one image, video, audio recording, document or sticker from an in-scope WhatsApp chat. '
    + 'Choose the optional `delivery` mode: "auto" (default) for a download link, "native" for inline MCP image/audio, '
    + '"file" for an embedded file, or "base64" for text-only byte chunks. '
    + 'Copy the chat `jid` and exact message `id` as `messageId` from read-messages or search-messages; do not infer an ID from a timestamp. '
    + 'For ordinary download requests, pass only jid and messageId. The default returns a temporary downloadUrl '
    + 'and file metadata; present downloadUrl as a clickable download link. Image previews are included when supported. '
    + 'The link expires after five minutes; call this tool again for a fresh link. '
    + 'Files over 10 MiB are refused. '
    + 'Use delivery: "native" when the client needs image/audio content directly; video and other formats remain embedded files. '
    + 'If a client needs bytes through text only, use `delivery: "base64"`: '
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
    delivery: z.enum(['auto', 'native', 'file', 'base64']).default('auto').describe('How to return the attachment: auto = temporary download link and supported image preview (default); native = inline MCP image/audio, with other formats embedded as resources; file = embedded resource for any format; base64 = text-only byte chunks using offset/limit. Native audio depends on client support.'),
    offset: z.number().int().min(0).max(WHATSAPP_MEDIA_MAX_BYTES).default(0).describe('For base64 delivery only: decoded byte offset, starting at 0; use nextOffset to continue'),
    limit: z.number().int().min(1).max(MAX_CHUNK_BYTES).default(DEFAULT_CHUNK_BYTES).describe('For base64 delivery only: maximum decoded bytes in this chunk, default 12 KiB and maximum 48 KiB'),
  },
  handler: async ({ jid, messageId, delivery = 'auto', offset = 0, limit = DEFAULT_CHUNK_BYTES }) => {
    const auth = useMcpAuth()
    const { scope } = auth
    assertChatAllowed(scope, jid)
    if (delivery !== 'base64' && (offset !== 0 || limit !== DEFAULT_CHUNK_BYTES)) {
      throw createError({ statusCode: 400, message: 'offset and limit apply only to delivery: "base64".' })
    }
    const { data, base64, filename, mimeType } = await fetchWhatsAppMedia(auth, jid, messageId)
    const meta = { jid, messageId, filename, mimeType, size: data.length, delivery, sha256: createHash('sha256').update(data).digest('hex') }

    if (delivery === 'auto') {
      const link = await createWhatsAppMediaDownload(auth, jid, messageId, meta.sha256)
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({
            ...meta, ...link,
            note: 'Show downloadUrl as a clickable download link with the file metadata. This retrieves the original file; it does not transcribe audio. If the link expires, call this tool again. No manual delivery settings or chunk prompts are needed.',
          }) },
          INLINE_IMAGE.has(mimeType)
            ? { type: 'image' as const, data: base64, mimeType }
            : { type: 'resource_link' as const, uri: link.downloadUrl, name: filename, mimeType, size: data.length },
        ],
      }
    }

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
      ? { type: 'image' as const, data: base64, mimeType }
      : delivery === 'native' && mimeType.startsWith('audio/')
        ? { type: 'audio' as const, data: base64, mimeType }
        : {
            type: 'resource' as const,
            resource: {
              uri: `whatsapp-media:///${encodeURIComponent(jid)}/${encodeURIComponent(messageId)}/${encodeURIComponent(filename)}`,
              mimeType,
              blob: base64,
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
