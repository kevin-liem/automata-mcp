import { z } from 'zod'

/**
 * Header criteria are SQL over synced rows. `text` is not — bodies are not
 * synced — so it goes to the mail server's own SEARCH, folder by folder, and
 * its UIDs are joined back onto the synced rows. Whatever that search could not
 * cover is named in `bodySearch`, because "no match" from a search that did
 * not run reads as "no such email".
 */
export default defineKindTool({
  name: 'search-emails',
  kind: 'imap',
  // Only `text` reaches the mail server (SEARCH BODY); headers are a local read.
  expensive: args => typeof args.text === 'string' && args.text.length > 0,
  title: 'Search emails',
  description:
    'Find emails by `from` (part of a sender\'s name or address), `to` (part of a To or Cc '
    + 'recipient), `subject` (words or part of the subject) and `text` (words in the body), '
    + 'combined with AND, optionally inside one `folder` and a `since`/`until` range. At least one '
    + 'of from, to, subject or text is required. Answers one page, newest first, in the same '
    + 'shape as list-emails: page with `nextPage` while `hasMore` is true. `from`, `to` and '
    + '`subject` match synced headers. `text` is passed to the mail server\'s own search, whose '
    + 'matching varies by provider (Gmail matches whole words, most servers substrings) and which '
    + 'only covers the folders listed in `bodySearch.searched` — finding nothing is not proof an '
    + 'email does not exist.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    from: z.string().min(1).max(320).optional().describe('Part of a sender\'s name or address, e.g. "acme.com" or "Maria"'),
    to: z.string().min(1).max(320).optional().describe('Part of a To or Cc recipient\'s name or address'),
    subject: z.string().min(1).max(500).optional().describe('Words in the subject, or part of it'),
    text: z.string().min(2).max(500).optional().describe('Words in the email body, searched by the mail server'),
    folder: z.string().min(1).max(1000).optional().describe('Folder path from list-mail-folders. Omit to search every synced folder.'),
    since: z.string().optional().describe('Only emails received at or after this date'),
    until: z.string().optional().describe('Only emails received at or before this date. Pass back `window.until` when paging.'),
    unread: z.boolean().optional().describe('true for unread emails only'),
    hasAttachments: z.boolean().optional().describe('true for emails with attachments only'),
    limit: z.number().int().min(1).max(100).default(25).describe('How many emails to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page, newest first'),
  },
  handler: async ({ from, to, subject, text, folder, since, until, unread, hasAttachments, limit, page }) => {
    if (!from && !to && !subject && !text) {
      throw createError({
        statusCode: 400,
        message: 'Pass at least one of `from`, `to`, `subject` or `text`. To browse without criteria, use list-emails.',
      })
    }
    const { instance, scope } = useMcpAuth()
    const { folders, allowed } = await foldersToRead(instance, scope, folder)

    const range = {
      since: parseDateBound(since, 'since')?.toISOString(),
      until: parseDateBound(until, 'until')?.toISOString() ?? (since ? new Date().toISOString() : undefined),
    }

    const body = text?.trim()
      ? await searchMessageBodies(instance, folders.map(f => ({ path: f.path, uidvalidity: f.uidvalidity })), text.trim())
      : undefined

    const [{ rows, hasMore, total }, sync] = await Promise.all([
      listMailPage(instance, {
        folder,
        allowed,
        limit,
        page,
        since: range.since ? new Date(range.since) : undefined,
        until: range.until ? new Date(range.until) : undefined,
        unread,
        hasAttachments,
        from,
        to,
        subject,
        ...(body && { uids: body.matches }),
      }),
      mailSyncState(instance),
    ])

    const covered = coveredMailSpan(rows)
    const notes = [
      hasMore ? incompleteMailNote('search-emails', page, Boolean(range.since)) : undefined,
      body?.skipped.length
        ? `The body search did not cover ${body.skipped.length} folder(s) (${body.skipped.join(', ')}): too many `
          + 'folders, out of time, or the server failed. Narrow it with `folder` to search those.'
        : undefined,
      !hasMore ? unsyncedHistoryNote(folders) : undefined,
      staleSyncNote(sync),
    ].filter((note): note is string => Boolean(note))

    return {
      ...(folder && { folder }),
      page,
      limit,
      count: rows.length,
      hasMore,
      ...(total !== undefined && { totalMatching: total, totalPages: Math.max(1, Math.ceil(total / limit)) }),
      ...(hasMore && { nextPage: page + 1 }),
      ...((range.since || range.until) && { window: range }),
      ...(covered && { covered }),
      ...(body && {
        bodySearch: {
          matching: body.gmail ? 'gmail' : 'server',
          searched: body.searched,
          ...(body.skipped.length > 0 && { skipped: body.skipped }),
        },
      }),
      ...(sync?.lastSuccessAt && { syncedAt: sync.lastSuccessAt }),
      ...(notes.length > 0 && { note: notes.join(' ') }),
      emails: rows.map(presentEmail),
    }
  },
})
