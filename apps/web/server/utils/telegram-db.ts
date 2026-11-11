import type { Sql } from 'postgres'
import type { AppInstance } from './app-db'
import type { McpScope } from './mcp-scope'
import type { SharedPool } from './pg-pool'

/**
 * Read-only access to a Telegram bridge's database — every Telegram message this
 * app reads. The counterpart of `evolution-db.ts`, and bound by the same rules:
 *
 *   1. Every table is named with its schema, `telegram.<table>`. The bridge
 *      shares a database with Evolution, and nothing here may depend on a search
 *      path. Columns are named too: a restricted reader (`TELEGRAM_READER_ROLE`
 *      on the bridge) is granted `chats` and `users` column by column — never
 *      `access_hash` or `phone` — so `SELECT *` would fail for it.
 *   2. Every query carries `session_id = <this connection's bridge session>`.
 *      `sessionIdOf` throws rather than widening when a row has none.
 *   3. Chat scope is a predicate in the SQL for listing and searching, and an
 *      assertion before reading one chat. Out-of-scope rows never enter this
 *      process.
 *
 * What differs from WhatsApp is what the rows mean, because the bridge is ours:
 * one row per message (no dedupe), edits overwrite in place, deletions are
 * tombstones, reactions are an aggregate, and the chat row says how far back
 * sync reached. The read functions carry that honestly rather than hiding it.
 */

const STATEMENT_TIMEOUT_MS = 10_000
const CHAT_ID = /^-?\d{1,20}$/

export type TelegramChatType = 'private' | 'bot' | 'group' | 'supergroup' | 'channel'
export type TelegramBackfillStop = 'start' | 'days' | 'count' | 'skipped' | 'inaccessible'

/** How much of a chat sync holds. `complete` alone means its first message was reached. */
export type TelegramHistory = {
  complete: boolean
  /** Why older history stops where it does; absent while it is still being fetched. */
  stoppedBecause?: Exclude<TelegramBackfillStop, 'start'>
  oldestSyncedAt?: string
  /** Sync could not replay this chat's history around this time; edits or deletions may be missing. */
  gapSince?: string
}

export type TelegramChatSummary = {
  /** Marked id, always a string. Negative for groups and channels. */
  chatId: string
  type: TelegramChatType
  title?: string
  username?: string
  isForum: boolean
  participantCount?: number
  unreadCount: number
  lastMessageAt?: string
  archived: boolean
  /** A basic group upgraded to a supergroup; newer messages are in that chat. */
  migratedTo?: string
  history: TelegramHistory
}

export type TelegramMessage = {
  id: number
  /** Which chat the message is in. Only on an account-wide read, which spans several. */
  chatId?: string
  /** That chat's title, when it has one. Only on an account-wide read. */
  chatTitle?: string
  fromMe: boolean
  /** The sender's name. Absent for your own messages (see `fromMe`) and where it is unknown. */
  author?: string
  senderId?: string
  timestamp: string
  /** Set when the message was edited. The text is the current version; the original is not kept. */
  editedAt?: string
  text?: string
  /** What kind of media the message carries, when it carries any; `text` is then its caption. */
  media?: string
  replyTo?: number
  topicId?: number
  forwardedFrom?: { chatId?: string, name?: string, date?: string }
  /** A service message (join, pin, title change…): its action, and no text. */
  service?: Record<string, unknown>
  reactions?: Array<{ emoji: string, count: number }>
  /** Messages sent together as an album share this. */
  albumId?: string
  /** Only when deleted messages were asked for: the message existed and was deleted. */
  deleted?: true
}

export type TelegramSearchHit = {
  chatId: string
  chatTitle?: string
  id: number
  fromMe: boolean
  author?: string
  timestamp: string
  editedAt?: string
  text: string
}

/** Whether the deployment's own bridge database is configured. */
export function telegramDatabaseConfigured(): boolean {
  return Boolean(useRuntimeConfig().telegramDatabaseUrl)
}

export function canReadTelegramMessages(instance: AppInstance): boolean {
  return telegramDbUrlFor(instance) !== undefined
}

/**
 * Which database this connection's chats are in. The only place the precedence
 * rule lives, mirroring `messageDbUrlFor`: the row's own URL wins and is
 * guarded; a connection on the deployment's bridge falls back to the
 * deployment's reader URL, unguarded because it is our own infrastructure and
 * `net-guard` would rightly refuse it; anything else has no answer.
 */
function telegramDbUrlFor(instance: AppInstance): { url: string, guard: boolean } | undefined {
  if (instance.telegram_db_url) return { url: instance.telegram_db_url, guard: true }
  if (!onDeploymentBridge(instance)) return undefined
  const url = useRuntimeConfig().telegramDatabaseUrl
  return url ? { url, guard: false } : undefined
}

async function telegramDbFor(instance: AppInstance): Promise<SharedPool> {
  const resolved = telegramDbUrlFor(instance)
  if (!resolved) {
    if (onDeploymentBridge(instance)) {
      console.error(
        '[telegram-db] NUXT_TELEGRAM_DATABASE_URL is not set — Telegram chats cannot be listed, '
        + 'read or searched for connections on this deployment\'s bridge.',
      )
      throw createError({ statusCode: 500, statusMessage: 'NUXT_TELEGRAM_DATABASE_URL is not set' })
    }
    throw createError({
      statusCode: 501,
      statusMessage: 'Claude cannot read this Telegram account\'s chats yet. Add your Telegram '
        + 'bridge\'s database connection string to this connection to enable listing, reading and '
        + 'searching. Sending already works without it.',
    })
  }

  const sql = await keyedPool(
    resolved.guard ? `tg:${instance.id}` : 'tg:default',
    resolved.url,
    { guard: resolved.guard, max: 3, statementTimeoutMs: STATEMENT_TIMEOUT_MS, readOnly: true },
  )
  // Shared by every connection on our own bridge: one statement in flight per
  // connection, as `evolutionDbFor` (GHSA-fpmx-gmx5-84vc).
  return sharedPoolFor(sql, !resolved.guard, `tg:${instance.id}`)
}

function sessionIdOf(instance: AppInstance): string {
  if (!instance.instance_id) {
    throw createError({ statusCode: 409, statusMessage: 'This Telegram connection is not fully provisioned' })
  }
  return instance.instance_id
}

/** A chat id is a string of digits. Anything else is refused before it reaches SQL. */
export function assertTelegramChatId(value: string, field = 'chatId'): string {
  if (CHAT_ID.test(value)) return value
  throw createError({
    statusCode: 400,
    message: `\`${field}\` must be a Telegram chat id written as a string of digits, e.g. "-1001234567890".`,
  })
}

/**
 * The chats a token may reach, as ids safe to bind, or undefined for an
 * all-chats token.
 *
 * The column is `chat_jids` for both kinds: WhatsApp JIDs on a WhatsApp token,
 * marked ids on a Telegram one. A token is bound to one connection of one kind,
 * so the two never meet. A value that is not a marked id is a misconfigured
 * token, and is refused loudly rather than left to match nothing — an empty
 * listing reads as "this account has no chats".
 */
export function scopedTelegramChatIds(scope: McpScope): string[] | undefined {
  if (scope.allChats) return undefined
  if (scope.chatJids.every(id => CHAT_ID.test(id))) return scope.chatJids
  console.error('[telegram-db] a Telegram token\'s chat scope holds ids that are not Telegram chat ids')
  throw createError({
    statusCode: 409,
    message: 'This connector token\'s chat list contains entries that are not Telegram chats. '
      + 'Ask the account owner to choose the token\'s chats again.',
  })
}

interface ChatDbRow {
  chat_id: string
  type: TelegramChatType
  title: string | null
  username: string | null
  is_forum: boolean
  participant_count: number | null
  unread_count: number
  last_message_at: Date | null
  archived: boolean
  migrated_to: string | null
  backfill_complete: boolean
  backfill_stopped: TelegramBackfillStop | null
  oldest_synced_at: Date | null
  gap_since: Date | null
}

function chatColumns(sql: Sql) {
  return sql`
    chat_id::text AS chat_id, type, title, username, is_forum, participant_count, unread_count,
    last_message_at, archived, migrated_to::text AS migrated_to, backfill_complete, backfill_stopped,
    oldest_synced_at, gap_since`
}

function toChatSummary(row: ChatDbRow): TelegramChatSummary {
  return {
    chatId: row.chat_id,
    type: row.type,
    ...(row.title && { title: row.title }),
    ...(row.username && { username: row.username }),
    isForum: row.is_forum,
    ...(row.participant_count !== null && { participantCount: row.participant_count }),
    unreadCount: row.unread_count,
    ...(row.last_message_at && { lastMessageAt: row.last_message_at.toISOString() }),
    archived: row.archived,
    ...(row.migrated_to && { migratedTo: row.migrated_to }),
    history: {
      complete: row.backfill_complete,
      ...(row.backfill_stopped && row.backfill_stopped !== 'start' && {
        stoppedBecause: row.backfill_stopped as Exclude<TelegramBackfillStop, 'start'>,
      }),
      ...(row.oldest_synced_at && { oldestSyncedAt: row.oldest_synced_at.toISOString() }),
      ...(row.gap_since && { gapSince: row.gap_since.toISOString() }),
    },
  }
}

/** Which column the chats table is ordered by. Named for the shared UI, not for the schema. */
export type TelegramChatSortKey = 'name' | 'number' | 'type' | 'last'

export interface TelegramChatListOptions {
  take: number
  skip: number
  allowedChatIds?: string[]
  /** Matched against title, username and id. A predicate in the SQL, never a post-filter. */
  q?: string
  sort?: TelegramChatSortKey
  dir?: 'asc' | 'desc'
}

/**
 * Synced chats, most recently active first by default.
 *
 * `hasMore` comes from over-fetching one row, never from a count, like every
 * other listing here — `total` rides along beside it for a table that wants to
 * say how many matched, and is absent for a page past the end.
 *
 * Search and ordering are predicates in this query rather than work done on rows
 * already read: the same rule chat scope follows, and what lets a page be one
 * page of the whole account rather than of whatever happened to be fetched.
 */
export async function listTelegramChats(
  instance: AppInstance,
  options: TelegramChatListOptions,
): Promise<{ chats: TelegramChatSummary[], hasMore: boolean, total?: number }> {
  const { query } = await telegramDbFor(instance)
  const sessionId = sessionIdOf(instance)

  const needle = options.q?.trim()
  const pattern = needle ? `%${escapeLike(needle)}%` : undefined

  const rows = await guarded('list chats', () => query(sql => sql<Array<ChatDbRow & { total: string }>>`
    SELECT ${chatColumns(sql)}, COUNT(*) OVER () AS total
    FROM telegram.chats
    WHERE session_id = ${sessionId}
      ${options.allowedChatIds ? sql`AND chat_id = ANY(${options.allowedChatIds}::bigint[])` : sql``}
      ${pattern === undefined
        ? sql``
        : sql`AND (title ILIKE ${pattern} OR username ILIKE ${pattern} OR chat_id::text ILIKE ${pattern})`}
    ORDER BY ${telegramChatOrdering(sql, options.sort, options.dir)}
    LIMIT ${options.take + 1} OFFSET ${options.skip}`))

  const total = Number(rows[0]?.total)

  return {
    chats: rows.slice(0, options.take).map(toChatSummary),
    hasMore: rows.length > options.take,
    total: Number.isFinite(total) ? total : undefined,
  }
}

/**
 * The ORDER BY for the chats table.
 *
 * `NULLS LAST` in **both** directions on purpose: a row with nothing in the
 * sorted column sinks either way, because flipping a sort to bring the blanks to
 * the top is never what anyone wanted. The `chat_id` tiebreaker is what stops a
 * row sharing a sort value from landing on two pages or on neither.
 */
function telegramChatOrdering(sql: Sql, sort: TelegramChatSortKey = 'last', dir: 'asc' | 'desc' = sort === 'last' ? 'desc' : 'asc') {
  const direction = dir === 'asc' ? sql`ASC` : sql`DESC`

  switch (sort) {
    case 'name':
      // The displayed name, not the column: the picker falls back to the
      // username and then to the id, and sorting on a bare title would scatter
      // every untitled chat away from where it is shown.
      return sql`lower(coalesce(title, username, chat_id::text)) ${direction} NULLS LAST, chat_id DESC`
    case 'number':
      return sql`username ${direction} NULLS LAST, chat_id DESC`
    case 'type':
      return sql`(type NOT IN ('private', 'bot')) ${direction} NULLS LAST, chat_id DESC`
    case 'last':
      return sql`last_message_at ${direction} NULLS LAST, chat_id DESC`
  }
}

/** One synced chat, or undefined. The caller has already checked scope. */
export async function telegramChat(instance: AppInstance, chatId: string): Promise<TelegramChatSummary | undefined> {
  assertTelegramChatId(chatId)
  const { query } = await telegramDbFor(instance)
  const sessionId = sessionIdOf(instance)
  const [row] = await guarded('read a chat', () => query(sql => sql<ChatDbRow[]>`
    SELECT ${chatColumns(sql)} FROM telegram.chats WHERE session_id = ${sessionId} AND chat_id = ${chatId}`))
  return row ? toChatSummary(row) : undefined
}

/**
 * One chat as the token scope picker and the chats dialog render it — the shape
 * they already use for WhatsApp, with the Telegram chat id in `jid`. One shape
 * rather than a second pair of components that drift apart.
 */
export type TelegramPickerChat = {
  jid: string
  name: string
  isGroup: boolean
  username?: string
  participantCount?: number
  lastMessageAt?: string
  telegramType: TelegramChatType
}

export async function listTelegramChatsForPicker(
  instance: AppInstance,
  options: TelegramChatListOptions,
): Promise<{ chats: TelegramPickerChat[], hasMore: boolean, total?: number }> {
  const { chats, hasMore, total } = await listTelegramChats(instance, options)
  return {
    hasMore,
    total,
    chats: chats.map(chat => ({
      jid: chat.chatId,
      name: chat.title || (chat.username ? `@${chat.username}` : chat.chatId),
      isGroup: chat.type !== 'private' && chat.type !== 'bot',
      ...(chat.username && { username: chat.username }),
      ...(chat.participantCount !== undefined && { participantCount: chat.participantCount }),
      ...(chat.lastMessageAt && { lastMessageAt: chat.lastMessageAt }),
      telegramType: chat.type,
    })),
  }
}

export interface TelegramPageOptions {
  /**
   * The one chat to read.
   *
   * Absent means every synced chat, which exists for the **session** surface —
   * the dashboard's message table. Every MCP tool passes one: `chat_id` is the
   * scope predicate, and a token scoped to a set of chats resolves them through
   * `scopedTelegramChatIds` before it gets here.
   */
  chatId?: string
  /** The only chats this token may reach. Omit for an all-chats token. */
  allowedChatIds?: string[]
  limit: number
  /** 1-based, counting back from the newest. */
  page: number
  since?: string
  until?: string
  topicId?: number
  includeDeleted: boolean
  includeService: boolean
  /** Every term must appear in the text. Already split, not yet escaped. */
  terms?: string[]
  /** Which end of the range the first page comes from. Defaults to newest first. */
  order?: 'newest' | 'oldest'
}

interface MessageDbRow {
  message_id: string
  chat_id?: string
  chat_title?: string | null
  sender_id: string | null
  from_me: boolean
  date: Date
  edit_date: Date | null
  text: string | null
  media_type: string | null
  reply_to_id: string | null
  topic_id: string | null
  fwd_from: { fromId?: string | null, fromName?: string | null, date?: string } | null
  service_action: Record<string, unknown> | null
  grouped_id: string | null
  reactions: Array<{ emoji: string, count: number }> | null
  deleted_at: Date | null
  first_name: string | null
  last_name: string | null
  user_username: string | null
  sender_chat_title: string | null
}

/**
 * One page of a chat's synced history, newest first.
 *
 * Deleted and service messages are excluded **in SQL** unless asked for, so the
 * page boundaries, `hasMore` and `total` all describe the same set; how many of
 * each the window holds is counted separately over the whole window and
 * reported, because a page that quietly loses a class of message reads as a
 * complete one.
 */
export async function listTelegramMessagesPage(
  instance: AppInstance,
  options: TelegramPageOptions,
): Promise<{ messages: TelegramMessage[], hasMore: boolean, total?: number, excluded: { deleted: number, service: number } }> {
  if (options.chatId !== undefined) assertTelegramChatId(options.chatId)
  const { query } = await telegramDbFor(instance)
  const sessionId = sessionIdOf(instance)
  const since = parseDateBound(options.since, 'since')
  const until = parseDateBound(options.until, 'until')
  // Checked again by `textMatchesAll`; here so the 400 comes before any query.
  if (options.terms) assertSearchTerms(options.terms)

  // Everything that bounds the set, shared by the page and the excluded counts
  // so the two describe the same window — the scope predicates included, because
  // a count taken over a wider set than the page is a number about someone
  // else's messages.
  const window = (sql: Sql) => sql`
    ${options.chatId === undefined ? sql`` : sql`AND m.chat_id = ${options.chatId}`}
    ${options.allowedChatIds ? sql`AND m.chat_id = ANY(${options.allowedChatIds}::bigint[])` : sql``}
    ${options.terms === undefined ? sql`` : textMatchesAll(sql, sql`m.text`, options.terms)}
    ${since ? sql`AND m.date >= ${since}` : sql``}
    ${until ? sql`AND m.date <= ${until}` : sql``}
    ${options.topicId === undefined ? sql`` : sql`AND m.topic_id = ${options.topicId}`}`

  // The tiebreaker travels with the direction; reversing one half of the pair
  // puts a row sharing a timestamp on two pages or on neither.
  const ordering = (sql: Sql) => options.order === 'oldest'
    ? sql`m.date ASC, m.message_id ASC`
    : sql`m.date DESC, m.message_id DESC`

  const [rows, counts] = await Promise.all([
    guarded('read messages', () => query(sql => sql<Array<MessageDbRow & { total: string }>>`
      SELECT m.chat_id::text AS chat_id, c.title AS chat_title,
             m.message_id::text AS message_id, m.sender_id::text AS sender_id, m.from_me, m.date, m.edit_date,
             m.text, m.media_type, m.reply_to_id::text AS reply_to_id, m.topic_id::text AS topic_id,
             m.fwd_from, m.service_action, m.grouped_id::text AS grouped_id, m.reactions, m.deleted_at,
             u.first_name, u.last_name, u.username AS user_username, sc.title AS sender_chat_title,
             COUNT(*) OVER () AS total
      FROM telegram.messages m
      LEFT JOIN telegram.chats c ON c.session_id = m.session_id AND c.chat_id = m.chat_id
      LEFT JOIN telegram.users u ON u.session_id = m.session_id AND u.user_id = m.sender_id
      LEFT JOIN telegram.chats sc ON sc.session_id = m.session_id AND sc.chat_id = m.sender_id AND m.sender_id < 0
      WHERE m.session_id = ${sessionId}
        ${window(sql)}
        ${options.includeDeleted ? sql`` : sql`AND m.deleted_at IS NULL`}
        ${options.includeService ? sql`` : sql`AND m.service_action IS NULL`}
      ORDER BY ${ordering(sql)}
      LIMIT ${options.limit + 1} OFFSET ${(options.page - 1) * options.limit}`)),
    options.includeDeleted && options.includeService
      ? Promise.resolve([{ deleted: '0', service: '0' }])
      : guarded('count excluded messages', () => query(sql => sql<Array<{ deleted: string, service: string }>>`
          SELECT count(*) FILTER (WHERE m.deleted_at IS NOT NULL) AS deleted,
                 count(*) FILTER (WHERE m.deleted_at IS NULL AND m.service_action IS NOT NULL) AS service
          FROM telegram.messages m
          WHERE m.session_id = ${sessionId}
            ${window(sql)}`)),
  ])

  const total = Number(rows[0]?.total)
  const count = counts[0]

  return {
    messages: rows.slice(0, options.limit).map(toMessage),
    hasMore: rows.length > options.limit,
    // Rides on the returned rows, so a page past the end carries no count rather
    // than a zero — "not measured" and "none" are different answers.
    total: Number.isFinite(total) ? total : undefined,
    excluded: {
      deleted: options.includeDeleted ? 0 : Number(count?.deleted ?? 0),
      service: options.includeService ? 0 : Number(count?.service ?? 0),
    },
  }
}

export interface TelegramSearchOptions {
  /** Every term must appear in the message text. Already split, not yet escaped. */
  terms: string[]
  chatId?: string
  /** The only chats this token may reach. Omit for an all-chats token. */
  allowedChatIds?: string[]
  since?: string
  until?: string
  fromMe?: boolean
  limit: number
}

/**
 * Messages whose current text (or media caption) contains every term, newest
 * first. Deleted messages have no text left to match. An edit is matched on its
 * current wording only — the earlier one is not kept.
 */
export async function searchTelegramMessages(
  instance: AppInstance,
  options: TelegramSearchOptions,
): Promise<{ hits: TelegramSearchHit[], truncated: boolean }> {
  if (options.chatId) assertTelegramChatId(options.chatId)
  const { query } = await telegramDbFor(instance)
  const sessionId = sessionIdOf(instance)
  const since = parseDateBound(options.since, 'since')
  const until = parseDateBound(options.until, 'until')
  assertSearchTerms(options.terms)

  const rows = await guarded('search messages', () => query(sql => sql<Array<MessageDbRow & { chat_id: string, chat_title: string | null }>>`
    SELECT m.chat_id::text AS chat_id, c.title AS chat_title,
           m.message_id::text AS message_id, m.sender_id::text AS sender_id, m.from_me, m.date, m.edit_date,
           m.text, u.first_name, u.last_name, u.username AS user_username, sc.title AS sender_chat_title
    FROM telegram.messages m
    JOIN telegram.chats c ON c.session_id = m.session_id AND c.chat_id = m.chat_id
    LEFT JOIN telegram.users u ON u.session_id = m.session_id AND u.user_id = m.sender_id
    LEFT JOIN telegram.chats sc ON sc.session_id = m.session_id AND sc.chat_id = m.sender_id AND m.sender_id < 0
    WHERE m.session_id = ${sessionId}
      AND m.deleted_at IS NULL
      ${textMatchesAll(sql, sql`m.text`, options.terms)}
      ${options.chatId ? sql`AND m.chat_id = ${options.chatId}` : sql``}
      ${options.allowedChatIds ? sql`AND m.chat_id = ANY(${options.allowedChatIds}::bigint[])` : sql``}
      ${since ? sql`AND m.date >= ${since}` : sql``}
      ${until ? sql`AND m.date <= ${until}` : sql``}
      ${options.fromMe === undefined ? sql`` : sql`AND m.from_me = ${options.fromMe}`}
    ORDER BY m.date DESC, m.message_id DESC
    LIMIT ${options.limit + 1}`))

  return {
    truncated: rows.length > options.limit,
    hits: rows.slice(0, options.limit).map(row => ({
      chatId: row.chat_id,
      ...(row.chat_title && { chatTitle: row.chat_title }),
      id: Number(row.message_id),
      fromMe: row.from_me,
      ...authorOf(row),
      timestamp: row.date.toISOString(),
      ...(row.edit_date && { editedAt: row.edit_date.toISOString() }),
      text: row.text ?? '',
    })),
  }
}

function toMessage(row: MessageDbRow): TelegramMessage {
  const forward = row.fwd_from
  return {
    id: Number(row.message_id),
    // Only the account-wide read selects these; one chat's page already knows
    // which chat it asked for and does not repeat it on every row.
    ...(row.chat_id && { chatId: row.chat_id }),
    ...(row.chat_title && { chatTitle: row.chat_title }),
    fromMe: row.from_me,
    ...authorOf(row),
    ...(row.sender_id && { senderId: row.sender_id }),
    timestamp: row.date.toISOString(),
    ...(row.edit_date && { editedAt: row.edit_date.toISOString() }),
    ...(row.text !== null && { text: row.text }),
    ...(row.media_type && { media: row.media_type }),
    ...(row.reply_to_id && { replyTo: Number(row.reply_to_id) }),
    ...(row.topic_id && { topicId: Number(row.topic_id) }),
    ...(forward && {
      forwardedFrom: {
        ...(forward.fromId && { chatId: forward.fromId }),
        ...(forward.fromName && { name: forward.fromName }),
        ...(forward.date && { date: forward.date }),
      },
    }),
    ...(row.service_action && { service: row.service_action }),
    ...(row.reactions && row.reactions.length > 0 && { reactions: row.reactions }),
    ...(row.grouped_id && { albumId: row.grouped_id }),
    ...(row.deleted_at && { deleted: true as const }),
  }
}

/**
 * The sender's name: the user's first and last name, their @username, or — for a
 * message posted as a channel or anonymous admin — that chat's title. Never for a
 * message you sent, which `fromMe` already describes.
 */
function authorOf(row: Pick<MessageDbRow, 'from_me' | 'first_name' | 'last_name' | 'user_username' | 'sender_chat_title'>): { author?: string } {
  if (row.from_me) return {}
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ')
    || (row.user_username ? `@${row.user_username}` : '')
    || row.sender_chat_title
  return name ? { author: name } : {}
}

/** A database failure becomes a logged 503 — a handled error leaves nothing in Nitro's log. */
async function guarded<T>(what: string, query: () => Promise<T>): Promise<T> {
  try {
    return await query()
  }
  catch (error) {
    if ((error as { statusCode?: number })?.statusCode) throw error
    console.error(`[telegram-db] could not ${what}:`, error)
    throw createError({ statusCode: 503, statusMessage: 'Reading Telegram chats is temporarily unavailable', cause: error })
  }
}
