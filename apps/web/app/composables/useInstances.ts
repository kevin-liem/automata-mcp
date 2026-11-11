import { assertNever } from '#shared/connection'
import type { InstanceKind } from '#shared/connection'

/**
 * The connection shape the UI works with, mirroring `toPublicInstance` on the
 * server. Kept in one place so a card, a listing and a dashboard cannot disagree
 * about what a connection is.
 *
 * `InstanceKind` itself is shared with the server — see `shared/connection.ts`.
 */
export type { InstanceKind }

export interface PublicInstanceRow {
  id: string
  kind: InstanceKind
  name: string
  label: string
  created?: string
  /** Where it points, for display. Never credentials. */
  target?: string
  /** WhatsApp only: true when it uses an Evolution server the user supplied. */
  ownServer?: boolean
  /** WhatsApp only: whether the read tools can answer for this connection. */
  canReadMessages?: boolean
  /**
   * WhatsApp only, while never paired: when the connection is deleted
   * automatically if nobody pairs it. Absent once paired.
   */
  unpairedRemovalAt?: string
}

/**
 * One connection in the listing, as `/api/instances` returns it: a
 * `PublicInstanceRow` plus the live state the route resolves per kind.
 *
 * Declared once because the page and the card were carrying identical copies,
 * field for field — and a field added to only one of them is a silent gap
 * rather than a type error.
 */
export interface InstanceListRow {
  id: string
  kind: InstanceKind
  label: string
  state: ConnectionState
  /** WhatsApp only: was connected, and Evolution's live socket no longer is. */
  sessionLost?: boolean
  /** WhatsApp only: Evolution keeps reopening the socket. See `rowChurn` on the server. */
  flapping?: boolean
  /** WhatsApp only: reads `open`, but its socket was found dead since it last opened. See `socketStalled` on the server. */
  stalled?: boolean
  /** With `flapping` or `stalled`: the deployment's operator is alerted and will restart Evolution. */
  operatorAlerted?: boolean
  target?: string
  detail?: string
  profileName?: string
  number?: string
  /** WhatsApp only. Absent for kinds with no message counts. */
  stats?: { messages: number, chats: number, contacts: number }
  /**
   * Whether this actor may change the connection — delete it, reconnect it,
   * rotate its credentials — as opposed to merely use it.
   *
   * Decided by the server and carried on the row rather than recomputed from
   * the session role, for the same reason `canReadMessages` is: one rule, one
   * place. It gates presentation only; every action it hides is independently
   * refused with a 403.
   */
  canManage?: boolean
}

/** What to call this kind of connection in prose, singular. */
export function describeKind(kind: InstanceKind): string {
  switch (kind) {
    case 'postgres':
      return 'database'
    case 'whatsapp':
      return 'WhatsApp account'
    case 'telegram':
      return 'Telegram account'
    case 'imap':
      return 'mailbox'
    default:
      return assertNever(kind, 'connection kind')
  }
}

/**
 * The message to show for a failed `$fetch`.
 *
 * `data.message` first, deliberately: the server puts its actual diagnosis
 * there — which host was refused, which database answered, which SQLSTATE — and
 * `statusMessage` is the generic. Five call sites had drifted into three
 * different orderings of these two keys, so the same failure read differently
 * depending on which component you were looking at.
 *
 * Reading the message is showing it: the caller renders it inline, so the
 * error is marked handled and the global error toast stays off it.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  markErrorHandled(error)
  const data = (error as { data?: { message?: string, statusMessage?: string } })?.data
  return data?.message || data?.statusMessage || fallback
}

/**
 * What an IMAP connection is created or updated with. `port` stays a string
 * while it is typed; `imapCredentialsBody()` turns it into what the server
 * validates.
 */
export interface ImapCredentials {
  host: string
  port: string
  security: 'tls' | 'starttls'
  user: string
  password: string
}

export function emptyImapCredentials(): ImapCredentials {
  return { host: '', port: '993', security: 'tls', user: '', password: '' }
}

/** The request body, or undefined while a field the server requires is missing. */
export function imapCredentialsBody(value: ImapCredentials) {
  const port = Number(value.port.trim() || (value.security === 'tls' ? 993 : 143))
  if (!value.host.trim() || !value.user.trim() || !value.password || !Number.isInteger(port)) return undefined
  return {
    host: value.host.trim(),
    port,
    security: value.security,
    user: value.user.trim(),
    password: value.password,
  }
}
