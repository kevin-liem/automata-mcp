import { assertNever } from '#shared/connection'

export interface McpToolInfo {
  name: string
  title: string
  description: string
  readOnly: boolean
}

export interface ScopedChat {
  jid: string
  /**
   * WhatsApp only: every JID this row stands for, when more than one — a person
   * stored under both a LID and a phone number. Picking the row picks all.
   */
  jids?: string[]
  name: string
  isGroup?: boolean
  /** Bare phone number of a 1:1 WhatsApp chat. Groups do not have one. */
  number?: string
  /**
   * WhatsApp LID chats only: the phone number behind the alias, when WhatsApp
   * revealed it on a live message. Absent means unknown, not "has none". The
   * chat is still the LID — scope and replies follow `jid`, not this.
   */
  phoneNumber?: string
  /** Telegram only: the chat's public @username, without the @. */
  username?: string
  /** IMAP only: emails synced in this folder. */
  messages?: number
  /** IMAP only: false for a folder that exists but is not synced (Junk, Trash, All Mail). */
  synced?: boolean
  /** Members in a group. Absent when the group lookup was skipped as unnecessary. */
  participantCount?: number
  profilePicUrl?: string
  /** Evolution's Chat row mtime, ISO 8601. A fallback when lastMessageAt is absent. */
  updatedAt?: string
  /** When the last message was sent, ISO 8601, when Evolution's row carries one. */
  lastMessageAt?: string
}

/** One reachable Postgres relation, `schema.table`, case-sensitive. */
export interface ScopedTable {
  qname: string
  schema: string
  name: string
  kind: string
  comment?: string
  estimatedRows?: number | null
}

export interface TokenScope {
  all_tools: boolean
  tool_names: string[]
  all_chats: boolean
  chat_jids: string[]
  all_tables: boolean
  table_names: string[]
}

export function openScope(): TokenScope {
  return {
    all_tools: true,
    tool_names: [],
    all_chats: true,
    chat_jids: [],
    all_tables: true,
    table_names: [],
  }
}

/**
 * Initial scope for a new token on a Postgres or mailbox connection: every
 * read tool, no write tool.
 *
 * Read-only is the default because the cost of the two mistakes is not
 * symmetric — a token that turns out to need writes is one edit away, and a
 * token that turns out not to have needed them may already have made some.
 * The caller passes the read tools because only the server knows what they are.
 */
export function readOnlyScope(readToolNames: string[]): TokenScope {
  return {
    all_tools: false,
    tool_names: [...readToolNames],
    all_chats: true,
    chat_jids: [],
    all_tables: true,
    table_names: [],
  }
}

/**
 * One-line summary for the tokens table.
 *
 * Only the axis that applies to this connection's kind is mentioned: a Postgres
 * token leaves `all_chats` at its default `true`, and reporting "All chats" for
 * a database would be noise at best.
 */
export function describeScope(scope: TokenScope, kind: InstanceKind): string {
  let dataOpen: boolean
  let data: string
  switch (kind) {
    case 'postgres':
      dataOpen = scope.all_tables
      data = scope.all_tables ? 'All tables' : plural(scope.table_names.length, 'table')
      break
    case 'whatsapp':
    case 'telegram':
      dataOpen = scope.all_chats
      data = scope.all_chats ? 'All chats' : plural(scope.chat_jids.length, 'chat')
      break
    // Folders ride the chat axis (`chat_jids` holds paths on a mail token).
    case 'imap':
      dataOpen = scope.all_chats
      data = scope.all_chats ? 'All folders' : plural(scope.chat_jids.length, 'folder')
      break
    default:
      return assertNever(kind, 'connection kind')
  }

  if (scope.all_tools && dataOpen) return 'Full access'
  return [data, scope.all_tools ? 'all actions' : plural(scope.tool_names.length, 'action')].join(' · ')
}

/** What the disclaimer field holds when an admin turns it on. Editable from there. */
export const DEFAULT_SEND_DISCLAIMER = 'Sent using DOPE'

/**
 * The tool that sends messages on this kind of connection, if it has one.
 *
 * Named rather than inferred from "any write tool": the disclaimer is applied
 * inside these handlers specifically, so a future write tool is not covered by
 * it until it applies the disclaimer itself and is named here.
 */
function sendToolOf(kind: InstanceKind): string | undefined {
  switch (kind) {
    case 'whatsapp':
      return 'send-text-message'
    case 'telegram':
      return 'send-telegram-message'
    case 'postgres':
    case 'imap':
      return undefined
    default:
      return assertNever(kind, 'connection kind')
  }
}

/** Whether a token with this scope may send messages from the account. */
export function allowsSending(scope: TokenScope, kind: InstanceKind): boolean {
  const tool = sendToolOf(kind)
  if (!tool) return false
  return scope.all_tools || scope.tool_names.includes(tool)
}

/**
 * The `send_disclaimer` to submit. A token that cannot send stores none, so
 * turning sending off and back on later does not revive a disclaimer nobody
 * could see while it was hidden; a blank field is off, not an empty line.
 */
export function disclaimerToSubmit(scope: TokenScope, kind: InstanceKind, disclaimer: string | null): string | null {
  if (!allowsSending(scope, kind)) return null
  return disclaimer?.trim() || null
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
