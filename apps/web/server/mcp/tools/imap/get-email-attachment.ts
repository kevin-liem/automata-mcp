import { z } from 'zod'

/** Image types every MCP client renders. Anything else goes back as an embedded file. */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_TEXT_CHARS = 100_000

/**
 * Fetch one attachment's bytes from the mail server and hand them back in the
 * same response. Never stored — not in the database, not on disk.
 *
 * `part` must be one the synced row lists as an attachment. Accepting any part
 * id would make this a way to read message bodies and nested messages through
 * a route meant for files, which is the one thing the check costs nothing to
 * prevent. The size cap is checked against BODYSTRUCTURE first, so an
 * oversized file is refused without downloading it, and enforced again on the
 * bytes, since a server's reported size is a claim.
 */
export default defineKindTool({
  name: 'get-email-attachment',
  kind: 'imap',
  title: 'Get email attachment',
  description:
    'Fetch one attachment of an email: an `emailId` from list-emails, search-emails or '
    + 'read-email, and a `part` from that email\'s attachment list. Images (PNG, JPEG, GIF, WebP) '
    + 'come back as images, text files (plain text, CSV, JSON, XML, HTML, calendar invites) as '
    + 'text, and anything else — PDFs, Office documents, archives — as an embedded file with its '
    + 'type. Attachments larger than the limit are refused with their size. Fetch only what the '
    + 'task needs: each call downloads the file from the mail server.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    emailId: z.string().min(1).max(2000).describe('The emailId the attachment belongs to'),
    part: z.string().regex(/^\d+(\.\d+)*$/, 'a part id like "2" or "1.3"').describe('The attachment\'s `part`, from the email\'s attachment list'),
  },
  handler: async ({ emailId, part }) => {
    const { instance, scope } = useMcpAuth()
    const ref = decodeEmailId(emailId)
    assertFolderAllowed(scope, ref.folderPath)

    const row = await getMailRow(instance, ref, scopedMailFolders(scope))
    if (!row) {
      throw createError({
        statusCode: 404,
        message: 'No synced email has this id — it may have been deleted or moved since it was listed. List the folder again.',
      })
    }
    const attachment = row.attachments.find(a => a.part === part)
    if (!attachment) {
      const parts = row.attachments.map(a => a.part).join(', ')
      throw createError({
        statusCode: 404,
        message: parts
          ? `This email has no attachment with part "${part}". Its attachments are parts ${parts}.`
          : 'This email has no attachments.',
      })
    }

    const maxBytes = attachmentMaxBytes()
    if (attachment.size !== undefined && attachment.size > maxBytes) {
      throw createError({
        statusCode: 413,
        message: `This attachment is about ${formatBytes(attachment.size)}, larger than the ${formatBytes(maxBytes)} this connector fetches.`,
      })
    }

    const file = await downloadAttachment(instance, row, attachment, maxBytes)
    const meta = {
      emailId,
      part,
      ...(file.filename && { filename: file.filename }),
      mimeType: file.mimeType,
      size: file.data.length,
    }

    if (INLINE_IMAGE.has(file.mimeType)) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
          { type: 'image' as const, data: file.data.toString('base64'), mimeType: file.mimeType },
        ],
      }
    }

    if (isTextual(file.mimeType)) {
      const text = file.data.toString('utf8')
      const clipped = text.length > MAX_TEXT_CHARS
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ...meta, ...(clipped && { truncatedAtChars: MAX_TEXT_CHARS }) }, null, 2) },
          { type: 'text' as const, text: clipped ? text.slice(0, MAX_TEXT_CHARS) : text },
        ],
      }
    }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
        {
          type: 'resource' as const,
          resource: {
            uri: `attachment:///${encodeURIComponent(file.filename ?? `part-${part}`)}`,
            mimeType: file.mimeType,
            blob: file.data.toString('base64'),
          },
        },
      ],
    }
  },
})

function isTextual(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || /^application\/(json|xml|csv|x-csv|ics|javascript|x-yaml|yaml)$/.test(mimeType)
    || /\+(json|xml)$/.test(mimeType)
}
