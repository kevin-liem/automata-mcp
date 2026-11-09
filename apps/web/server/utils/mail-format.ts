import type { AppInstance } from './app-db'
import type { McpScope } from './mcp-scope'
import type { MailAttachment } from './imap-client'
import type { MailFolder, MailRow, MailSyncState } from './imap-db'

/**
 * How the IMAP tools present a stored message and say what they could not
 * see. Shared so `list-emails`, `search-emails` and `read-email` describe one
 * email in the same words, and a model can carry what it learned from one
 * response to the next.
 */

/** One email as a listing shows it: headers and attachment names, no body. */
export function presentEmail(row: MailRow) {
  return {
    emailId: encodeEmailId(row),
    folders: row.folders,
    date: row.sentAt ?? row.receivedAt,
    receivedAt: row.receivedAt,
    from: row.from.map(formatAddress),
    to: row.to.map(formatAddress),
    ...(row.cc.length > 0 && { cc: row.cc.map(formatAddress) }),
    subject: row.subject,
    unread: !row.flags.includes('\\Seen'),
    ...(row.flags.includes('\\Flagged') && { flagged: true }),
    ...(row.flags.includes('\\Answered') && { answered: true }),
    ...(row.attachments.length > 0 && { attachments: row.attachments.map(presentAttachment) }),
  }
}

export function presentAttachment(attachment: MailAttachment) {
  return {
    part: attachment.part,
    ...(attachment.filename && { filename: attachment.filename }),
    mimeType: attachment.mimeType,
    ...(attachment.size !== undefined && { size: attachment.size }),
    ...(attachment.inline && { inline: true }),
  }
}

/** `Name <address>`, or whichever half exists. */
export function formatAddress(address: { name?: string, address?: string }): string {
  if (address.name && address.address) return `${address.name} <${address.address}>`
  return address.address ?? address.name ?? ''
}

/** The span of dates a page actually covers. */
export function coveredMailSpan(rows: MailRow[]): { from: string, to: string } | undefined {
  const stamps = rows.map(row => row.receivedAt).sort()
  const from = stamps[0]
  const to = stamps[stamps.length - 1]
  return from && to ? { from, to } : undefined
}

/** How stale a listing is allowed to be before the response says so. */
const STALE_MS = 15 * 60_000

/**
 * A sentence when the sync is not current — a refused password, a failing
 * server, or simply no recent success — since a listing of synced headers
 * cannot show mail the sync never fetched, and an up-to-date-looking inbox is
 * the wrong answer to "did they reply?".
 */
export function staleSyncNote(sync: MailSyncState | undefined): string | undefined {
  if (!sync?.lastSuccessAt) {
    // A run in which any folder failed is not recorded as a success, so a
    // folder failing from the start leaves no success at all; say it failed
    // rather than that it is still running.
    return sync?.lastErrorAt
      ? 'The sync of this mailbox has not completed: its latest run failed, so this listing may be missing mail.'
      : 'This mailbox has not finished its first sync yet, so this listing may be missing mail. Try again in a few minutes.'
  }
  if (sync.authFailed) {
    return `The mail server is refusing this connection's password, so nothing newer than ${sync.lastSuccessAt} `
      + 'has been synced. The account owner needs to update the credentials in the web app.'
  }
  const age = Date.now() - Date.parse(sync.lastSuccessAt)
  if (age > STALE_MS) {
    return `The last successful sync was at ${sync.lastSuccessAt}; mail that arrived after that is not listed.`
  }
  return undefined
}

const STOPPED_BECAUSE: Record<NonNullable<MailFolder['history']['stopped']>, string> = {
  days: 'they are older than the period this connection syncs',
  count: 'the folder holds more messages than this connection syncs per folder',
}

/**
 * Said when paging reached the end of what is synced but the folders read
 * hold older mail that never was. Without it, `hasMore: false` reads as "this
 * is the oldest email", which it is not.
 */
export function unsyncedHistoryNote(folders: MailFolder[]): string | undefined {
  const partial = folders.filter(folder => folder.synced && !folder.history.complete)
  if (!partial.length) return undefined
  const parts = partial.map((folder) => {
    const why = folder.history.stopped
      ? STOPPED_BECAUSE[folder.history.stopped]
      : 'older mail is still being synced, so more may appear later'
    const oldest = folder.history.oldestSyncedAt ? ` (oldest synced: ${folder.history.oldestSyncedAt})` : ''
    return `"${folder.path}"${oldest} has older mail that is not synced because ${why}`
  })
  return `${parts.join('; ')}. You have reached the oldest synced email, not the oldest email in the mailbox — `
    + 'say so rather than treating this as the full history.'
}

export function incompleteMailNote(tool: string, page: number, bounded: boolean): string {
  const scope = bounded ? 'inside the requested window' : 'matching this request'
  return `Incomplete: this is page ${page}, and older emails ${scope} were NOT returned. Call ${tool} `
    + `again with page: ${page + 1} and otherwise the same arguments${bounded ? ', including the same window bounds' : ''}, `
    + 'and keep going until hasMore is false. Do not summarise until then.'
}

/**
 * The folders a listing reads: the one named, checked against scope and
 * against what exists, or every synced folder the token may reach.
 *
 * A named folder that is out of scope is a 403, one that does not exist a 404,
 * one that exists but is not synced a 409 — three different answers, because
 * each is a different thing to tell the user and none of them is "no mail".
 */
export async function foldersToRead(
  instance: Pick<AppInstance, 'id'>,
  scope: McpScope,
  folder: string | undefined,
): Promise<{ folders: MailFolder[], allowed?: string[] }> {
  const allowed = scopedMailFolders(scope)
  if (folder !== undefined) assertFolderAllowed(scope, folder)

  const all = await listMailFolders(instance, { allowed })
  if (folder === undefined) return { folders: all.filter(f => f.synced), allowed }

  const found = all.find(f => f.path === folder)
  if (!found) {
    throw createError({
      statusCode: 404,
      message: `This mailbox has no folder "${folder}". Take folder paths from list-mail-folders, exactly as listed.`,
    })
  }
  if (!found.synced) {
    throw createError({
      statusCode: 409,
      message: `The folder "${folder}" is not synced by this connector (All Mail, Junk, Trash and folders that `
        + 'cannot hold mail are skipped), so its emails cannot be listed or searched.',
    })
  }
  return { folders: [found], allowed }
}

/**
 * Where a draft goes: the folder the server marks `\Drafts`, else the one
 * folder named "Drafts". Never the caller's choice — a write tool that took a
 * folder argument could file mail anywhere in the mailbox.
 *
 * Looked up across every folder, scope or not, and only then checked against
 * scope: a scoped token without Drafts gets a 403 naming the folder to add,
 * where filtering first would answer "this mailbox has no Drafts folder",
 * which is false and leaves the owner nothing to fix.
 */
export async function draftsFolder(instance: Pick<AppInstance, 'id'>, scope: McpScope): Promise<MailFolder> {
  const all = await listMailFolders(instance)
  const marked = all.filter(f => f.specialUse === '\\Drafts')
  const named = all.filter(f => f.name.toLowerCase() === 'drafts')
  const found = marked.length === 1 ? marked[0] : marked.length === 0 && named.length === 1 ? named[0] : undefined

  if (!found) {
    if (!all.length) {
      throw createError({
        statusCode: 409,
        message: 'This mailbox has not finished its first sync, so its Drafts folder is not known yet. Try again in a few minutes.',
      })
    }
    throw createError({
      statusCode: 409,
      message: marked.length + named.length > 1
        ? 'This mailbox has more than one Drafts folder, so it is not clear which one the mail client uses. No draft was saved.'
        : 'This mailbox has no Drafts folder, so there is nowhere to save a draft. No draft was saved.',
    })
  }
  assertFolderAllowed(scope, found.path)
  return found
}
