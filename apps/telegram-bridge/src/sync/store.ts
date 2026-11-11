import type postgres from 'postgres'
import type { Sql } from '../db.ts'
import type { ChatRow, ChatType, MessageRow, Reaction, UserRow } from './convert.ts'
import { stubType } from './convert.ts'

/** A channel `getChannelDifference` can catch up, as `chats` stores it. */
export type TrackedChannel = { chat_id: string, access_hash: string, channel_pts: number }

/**
 * Every write sync makes, scoped to one session.
 *
 * Upserts are idempotent on purpose: the same message routinely arrives more
 * than once — from a live update, from teleproto's own difference fetch, from
 * ours, and from a backfill page — and the order is not guaranteed.
 *
 * **A tombstone is never resurrected.** Every message upsert is conditional on
 * `deleted_at IS NULL`, so a backfill page fetched a moment before a deletion
 * cannot put the deleted text back.
 */

type Db = Sql | postgres.TransactionSql

/**
 * One chat write, in the order the one-at-a-time path would have made it. Kept
 * as a list rather than folded by the caller because `refresh` depends on what
 * came before it: it touches a chat only if the chat exists by then.
 */
export type ChatOp =
  /** An entity that merely passed by: refreshes a chat this session has, never creates one. */
  | { op: 'refresh', row: ChatRow }
  /** The chat a stored message belongs to, with its entity. */
  | { op: 'upsert', row: ChatRow }
  /** The chat a stored message belongs to, whose entity has not arrived. */
  | { op: 'stub', chatId: string }

/** Everything one batch writes, each list in arrival order. */
export interface WriteBatch {
  users?: UserRow[]
  chats?: ChatOp[]
  messages?: MessageRow[]
  /** Per channel, the highest pts the batch's messages justify. Only moves forward. */
  channelPts?: Map<string, number>
  migrations?: { from: string, to: string }[]
}

export type BackfillStop = 'start' | 'days' | 'count' | 'skipped' | 'inaccessible'

export interface BackfillChat {
  chat_id: string
  type: ChatType
  access_hash: string | null
  backfill_cursor: string | null
  backfill_count: number
}

export interface KnownChat {
  chat_id: string
  type: ChatType
  title: string | null
  username: string | null
  access_hash: string | null
  migrated_to: string | null
}

export interface ChatListing {
  chatId: string
  type: ChatType
  title: string | null
  username: string | null
  isForum: boolean
  participantCount: number | null
  unreadCount: number
  lastMessageAt: string | null
  archived: boolean
  migratedTo: string | null
  backfillComplete: boolean
  backfillStopped: BackfillStop | null
  oldestSyncedAt: string | null
}

const INT4 = 23
const INT8 = 20
const TIMESTAMPTZ = 1184

export class SyncStore {
  private readonly sql: Sql
  private readonly sessionId: string

  constructor(sql: Sql, sessionId: string) {
    this.sql = sql
    this.sessionId = sessionId
  }

  async upsertUsers(rows: UserRow[]): Promise<void> {
    await this.usersQuery(this.sql, rows)
  }

  private usersQuery(db: Db, rows: UserRow[]) {
    const unique = mergeUsers(rows)
    if (unique.length === 0) return undefined
    return db`
      INSERT INTO users ${db(unique.map(row => ({ session_id: this.sessionId, ...row })))}
      ON CONFLICT (session_id, user_id) DO UPDATE SET
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        last_name = EXCLUDED.last_name,
        username = EXCLUDED.username,
        phone = COALESCE(EXCLUDED.phone, users.phone),
        access_hash = COALESCE(EXCLUDED.access_hash, users.access_hash),
        is_bot = EXCLUDED.is_bot,
        updated_at = now()`
  }

  /** Chats that carry messages: created when new, refreshed when known. */
  async upsertChats(rows: ChatRow[]): Promise<void> {
    await this.chatsQuery(this.sql, rows)
  }

  private chatsQuery(db: Db, rows: ChatRow[]) {
    const unique = mergeChats(rows)
    if (unique.length === 0) return undefined
    return db`
      INSERT INTO chats ${db(unique.map(row => ({ session_id: this.sessionId, ...row })))}
      ON CONFLICT (session_id, chat_id) DO UPDATE SET
        type = EXCLUDED.type,
        title = COALESCE(EXCLUDED.title, chats.title),
        username = COALESCE(EXCLUDED.username, chats.username),
        access_hash = COALESCE(EXCLUDED.access_hash, chats.access_hash),
        is_forum = EXCLUDED.is_forum,
        participant_count = COALESCE(EXCLUDED.participant_count, chats.participant_count),
        migrated_to = COALESCE(EXCLUDED.migrated_to, chats.migrated_to),
        updated_at = now()`
  }

  /**
   * Refresh chats this session already has, from entities that merely passed by
   * (a forward's origin, a group member). Never creates one: a channel someone
   * forwarded from is not a chat of yours.
   */
  async refreshKnownChats(rows: ChatRow[]): Promise<void> {
    const known = await this.existingChats(this.sql, rows.map(row => row.chat_id))
    await this.upsertChats(rows.filter(row => known.has(row.chat_id)))
  }

  private async existingChats(db: Db, chatIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(chatIds)]
    if (unique.length === 0) return new Set()
    const rows = await db<{ chat_id: string }[]>`
      SELECT chat_id FROM chats
      WHERE session_id = ${this.sessionId} AND chat_id = ANY(${db.array(unique, INT8)})`
    return new Set(rows.map(row => row.chat_id))
  }

  /** A placeholder row for a chat whose entity has not arrived, so its messages can be stored. */
  async ensureChats(chatIds: string[]): Promise<void> {
    await this.stubsQuery(this.sql, chatIds)
  }

  private stubsQuery(db: Db, chatIds: string[]) {
    const unique = [...new Set(chatIds)]
    if (unique.length === 0) return undefined
    return db`
      INSERT INTO chats ${db(unique.map(chatId => ({ session_id: this.sessionId, chat_id: chatId, type: stubType(chatId) })))}
      ON CONFLICT (session_id, chat_id) DO NOTHING`
  }

  async updateDialog(chatId: string, dialog: {
    topMessageId: number
    unreadCount: number
    lastMessageAt: Date | null
    archived: boolean
    pts: number | null
  }): Promise<void> {
    await this.sql`
      UPDATE chats SET
        top_message_id = GREATEST(top_message_id, ${dialog.topMessageId}),
        unread_count = ${dialog.unreadCount},
        last_message_at = GREATEST(last_message_at, ${dialog.lastMessageAt}),
        archived = ${dialog.archived},
        channel_pts = COALESCE(channel_pts, ${dialog.pts}),
        updated_at = now()
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId}`
  }

  async upsertMessages(rows: MessageRow[]): Promise<void> {
    for (const query of this.messagesQueries(this.sql, rows)) await query
  }

  /** The upsert, then the chats' latest-message bookkeeping. Run in this order. */
  private messagesQueries(db: Db, rows: MessageRow[]) {
    const unique = mergeMessages(rows)
    if (unique.length === 0) return []
    const json = (value: unknown) => value === null ? null : db.json(value as postgres.JSONValue)

    const upsert = db`
      INSERT INTO messages ${db(unique.map(row => ({
        session_id: this.sessionId,
        chat_id: row.chat_id,
        message_id: row.message_id,
        in_channel: row.in_channel,
        sender_id: row.sender_id,
        from_me: row.from_me,
        date: row.date,
        edit_date: row.edit_date,
        text: row.text,
        media_type: row.media_type,
        entities: json(row.entities),
        mentioned_user_ids: db.array(row.mentioned_user_ids, INT8),
        reply_to_id: row.reply_to_id,
        topic_id: row.topic_id,
        fwd_from: json(row.fwd_from),
        service_action: json(row.service_action),
        grouped_id: row.grouped_id,
        reactions: json(row.reactions),
      })))}
      ON CONFLICT (session_id, chat_id, message_id) DO UPDATE SET
        sender_id = EXCLUDED.sender_id,
        from_me = EXCLUDED.from_me,
        date = EXCLUDED.date,
        edit_date = EXCLUDED.edit_date,
        text = EXCLUDED.text,
        media_type = EXCLUDED.media_type,
        entities = EXCLUDED.entities,
        mentioned_user_ids = EXCLUDED.mentioned_user_ids,
        reply_to_id = EXCLUDED.reply_to_id,
        topic_id = EXCLUDED.topic_id,
        fwd_from = EXCLUDED.fwd_from,
        service_action = EXCLUDED.service_action,
        grouped_id = EXCLUDED.grouped_id,
        reactions = COALESCE(EXCLUDED.reactions, messages.reactions)
      WHERE messages.deleted_at IS NULL`

    // Over every row, not the merged ones: GREATEST is what one write per row
    // would have arrived at, whichever copy of a message carried the larger value.
    const latest = db`
      UPDATE chats SET
        last_message_at = GREATEST(chats.last_message_at, latest.date),
        top_message_id = GREATEST(chats.top_message_id, latest.message_id)
      FROM (
        SELECT chat_id, max(date) AS date, max(message_id) AS message_id
        FROM unnest(
          ${db.array(rows.map(row => row.chat_id), INT8)}::bigint[],
          ${db.array(rows.map(row => row.date.toISOString()), TIMESTAMPTZ)}::timestamptz[],
          ${db.array(rows.map(row => String(row.message_id)), INT8)}::bigint[]
        ) AS m (chat_id, date, message_id)
        GROUP BY chat_id
      ) AS latest
      WHERE chats.session_id = ${this.sessionId} AND chats.chat_id = latest.chat_id`

    return [upsert, latest]
  }

  /**
   * A batch of sync writes in one transaction, one statement per table.
   *
   * Comes out the same as making each write in `batch` one at a time, in order:
   * rows are merged by key the way their `ON CONFLICT` would have folded them
   * (`mergeUsers`, `mergeChats`, `mergeMessages`), `refresh` ops are resolved
   * against the chats that exist at that point in the sequence, and pts only
   * moves forward, so the order of the pts writes does not matter.
   *
   * The caller decides what may share a batch. Anything whose effect depends on
   * its position relative to these upserts — a deletion, a reaction count, an
   * exact pts — is not expressible here and has to be applied on its own.
   *
   * After the one read `refresh` needs, the statements go out pipelined: on a
   * transaction's connection postgres.js sends them back to back and Postgres
   * runs them in order, so the batch costs a handful of round trips whatever
   * its size. All or nothing: pts advances only with the messages that justify it.
   */
  async writeBatch(batch: WriteBatch): Promise<void> {
    const ops = batch.chats ?? []
    const messages = batch.messages ?? []
    const migrations = batch.migrations ?? []
    const channelPts = [...(batch.channelPts ?? new Map<string, number>())]
    const refreshIds = ops.flatMap(op => op.op === 'refresh' ? [op.row.chat_id] : [])

    await this.sql.begin(async (tx) => {
      const { rows, stubs } = resolveChatOps(ops, await this.existingChats(tx, refreshIds))
      const queries = [
        this.usersQuery(tx, batch.users ?? []),
        // Stubs before the upserts: a chat stubbed and then upserted in the same
        // batch ends as the upsert over a stub, which is what it would have been.
        this.stubsQuery(tx, stubs),
        this.chatsQuery(tx, rows),
        ...this.messagesQueries(tx, messages),
        channelPts.length === 0 ? undefined : tx`
          UPDATE chats SET channel_pts = GREATEST(COALESCE(chats.channel_pts, 0), p.pts)
          FROM unnest(
            ${tx.array(channelPts.map(([chatId]) => chatId), INT8)}::bigint[],
            ${tx.array(channelPts.map(([, pts]) => pts), INT4)}::integer[]
          ) AS p (chat_id, pts)
          WHERE chats.session_id = ${this.sessionId} AND chats.chat_id = p.chat_id`,
        ...migrations.flatMap(({ from, to }) => [
          this.stubsQuery(tx, [from]),
          this.migratedQuery(tx, from, to),
        ]),
      ]
      await Promise.all(queries.filter(query => query !== undefined))
    })
  }

  /** Deletions from private chats and basic groups arrive as bare ids; see messages_common_box_id. */
  async tombstoneCommon(messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return
    await this.sql`
      UPDATE messages SET text = NULL, entities = NULL, deleted_at = now()
      WHERE session_id = ${this.sessionId} AND NOT in_channel AND deleted_at IS NULL
        AND message_id = ANY(${this.sql.array(messageIds.map(String), INT8)})`
  }

  async tombstoneInChat(chatId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return
    await this.sql`
      UPDATE messages SET text = NULL, entities = NULL, deleted_at = now()
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId} AND deleted_at IS NULL
        AND message_id = ANY(${this.sql.array(messageIds.map(String), INT8)})`
  }

  async setReactions(chatId: string, messageId: number, reactions: Reaction[] | null): Promise<void> {
    await this.sql`
      UPDATE messages SET reactions = ${reactions === null ? null : this.sql.json(reactions as unknown as postgres.JSONValue)}
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId} AND message_id = ${messageId}`
  }

  private migratedQuery(db: Db, fromChatId: string, toChatId: string) {
    return db`
      UPDATE chats SET migrated_to = ${toChatId}, updated_at = now()
      WHERE session_id = ${this.sessionId} AND chat_id = ${fromChatId}`
  }

  /**
   * `exact` for a value from a difference, which is authoritative. Otherwise the
   * pts only moves forward: live updates can be applied out of order.
   */
  async setChannelPts(chatId: string, pts: number | null, exact: boolean): Promise<void> {
    if (exact) {
      await this.sql`UPDATE chats SET channel_pts = ${pts} WHERE session_id = ${this.sessionId} AND chat_id = ${chatId}`
      return
    }
    await this.sql`
      UPDATE chats SET channel_pts = GREATEST(COALESCE(channel_pts, 0), ${pts})
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId}`
  }

  async setGap(chatId: string): Promise<void> {
    await this.sql`
      UPDATE chats SET gap_since = COALESCE(gap_since, now())
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId}`
  }

  async maxMessageId(chatId: string): Promise<number | null> {
    const [row] = await this.sql<{ max: string | null }[]>`
      SELECT max(message_id)::text AS max FROM messages
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId}`
    return row?.max ? Number(row.max) : null
  }

  async chat(chatId: string): Promise<KnownChat | undefined> {
    const [row] = await this.sql<KnownChat[]>`
      SELECT chat_id, type, title, username, access_hash, migrated_to FROM chats
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId}`
    return row
  }

  async userAccessHash(userId: string): Promise<string | null> {
    const [row] = await this.sql<{ access_hash: string | null }[]>`
      SELECT access_hash FROM users WHERE session_id = ${this.sessionId} AND user_id = ${userId}`
    return row?.access_hash ?? null
  }

  async nextBackfillChat(): Promise<BackfillChat | undefined> {
    const [row] = await this.sql<BackfillChat[]>`
      SELECT chat_id, type, access_hash, backfill_cursor, backfill_count FROM chats
      WHERE session_id = ${this.sessionId} AND backfill_stopped IS NULL
      ORDER BY last_message_at DESC NULLS LAST, chat_id DESC
      LIMIT 1`
    return row
  }

  async recordBackfill(chatId: string, page: {
    cursor: number | null
    added: number
    oldest: Date | null
    stopped: BackfillStop | null
  }): Promise<void> {
    await this.sql`
      UPDATE chats SET
        backfill_cursor = COALESCE(${page.cursor}, backfill_cursor),
        backfill_count = backfill_count + ${page.added},
        oldest_synced_at = LEAST(oldest_synced_at, ${page.oldest}),
        backfill_stopped = ${page.stopped},
        backfill_complete = (${page.stopped}::text IS NOT DISTINCT FROM 'start'),
        updated_at = now()
      WHERE session_id = ${this.sessionId} AND chat_id = ${chatId}`
  }

  async stopBackfill(chatId: string, reason: BackfillStop): Promise<void> {
    await this.recordBackfill(chatId, { cursor: null, added: 0, oldest: null, stopped: reason })
  }

  /** Every channel that can be caught up, most recently active first. */
  async channelsForCatchUp(): Promise<TrackedChannel[]> {
    return await this.sql<TrackedChannel[]>`
      SELECT chat_id, access_hash, channel_pts FROM chats
      WHERE ${this.catchUpEligible()}
      ORDER BY last_message_at DESC NULLS LAST`
  }

  /** One channel, if it can be caught up. */
  async channelForCatchUp(chatId: string): Promise<TrackedChannel | undefined> {
    const [row] = await this.sql<TrackedChannel[]>`
      SELECT chat_id, access_hash, channel_pts FROM chats
      WHERE ${this.catchUpEligible()} AND chat_id = ${chatId}`
    return row
  }

  /** The one rule for which chats `getChannelDifference` can catch up. */
  private catchUpEligible() {
    return this.sql`session_id = ${this.sessionId} AND chat_id <= -1000000000000
        AND channel_pts IS NOT NULL AND access_hash IS NOT NULL AND migrated_to IS NULL`
  }

  async markDialogsSynced(): Promise<void> {
    await this.sql`UPDATE sessions SET dialogs_synced_at = now() WHERE id = ${this.sessionId}`
  }

  async saveUpdateState(state: { pts: number, qts: number, date: number, seq: number }): Promise<void> {
    await this.sql`
      UPDATE sessions SET update_pts = ${state.pts}, update_qts = ${state.qts},
        update_date = ${state.date}, update_seq = ${state.seq}
      WHERE id = ${this.sessionId}`
  }

  /** Everything synced for this session. Messages go with their chats. */
  async wipe(): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM chats WHERE session_id = ${this.sessionId}`
      await tx`DELETE FROM users WHERE session_id = ${this.sessionId}`
      await tx`
        UPDATE sessions SET data_user_id = NULL, dialogs_synced_at = NULL,
          update_pts = NULL, update_qts = NULL, update_date = NULL, update_seq = NULL
        WHERE id = ${this.sessionId}`
    })
  }

  async listChats(take: number, skip: number): Promise<{ chats: ChatListing[], hasMore: boolean }> {
    const rows = await this.sql<{
      chat_id: string
      type: ChatType
      title: string | null
      username: string | null
      is_forum: boolean
      participant_count: number | null
      unread_count: number
      last_message_at: Date | null
      archived: boolean
      migrated_to: string | null
      backfill_complete: boolean
      backfill_stopped: BackfillStop | null
      oldest_synced_at: Date | null
    }[]>`
      SELECT chat_id, type, title, username, is_forum, participant_count, unread_count, last_message_at,
             archived, migrated_to, backfill_complete, backfill_stopped, oldest_synced_at
      FROM chats WHERE session_id = ${this.sessionId}
      ORDER BY last_message_at DESC NULLS LAST, chat_id DESC
      LIMIT ${take + 1} OFFSET ${skip}`

    return {
      hasMore: rows.length > take,
      chats: rows.slice(0, take).map(row => ({
        chatId: row.chat_id,
        type: row.type,
        title: row.title,
        username: row.username,
        isForum: row.is_forum,
        participantCount: row.participant_count,
        unreadCount: row.unread_count,
        lastMessageAt: row.last_message_at?.toISOString() ?? null,
        archived: row.archived,
        migratedTo: row.migrated_to,
        backfillComplete: row.backfill_complete,
        backfillStopped: row.backfill_stopped,
        oldestSyncedAt: row.oldest_synced_at?.toISOString() ?? null,
      })),
    }
  }
}

/**
 * Which chat rows a batch upserts and which chats it stubs, from its ops in order.
 * `existing` = the chats a `refresh` names that exist before the batch.
 */
function resolveChatOps(ops: ChatOp[], existing: Set<string>): { rows: ChatRow[], stubs: string[] } {
  const exists = new Set(existing)
  const rows: ChatRow[] = []
  const stubs: string[] = []
  for (const op of ops) {
    if (op.op === 'refresh') {
      if (exists.has(op.row.chat_id)) rows.push(op.row)
    }
    else if (op.op === 'upsert') {
      rows.push(op.row)
      exists.add(op.row.chat_id)
    }
    else if (!exists.has(op.chatId)) {
      // A chat that existed before the batch but no `refresh` asked about lands
      // here too; the stub insert does nothing to it.
      stubs.push(op.chatId)
      exists.add(op.chatId)
    }
  }
  return { rows, stubs }
}

/*
 * Postgres refuses an upsert that touches one row twice, so rows sharing a key
 * are folded first — and folded the way their `ON CONFLICT` clause would have
 * folded them had each been written on its own: a COALESCE column keeps the last
 * non-null value, every other column takes the last row's. Last-wins alone would
 * drop an earlier non-null `phone`, `title` or `reactions` that one write per row
 * keeps. Each merge mirrors the SET list of its statement above; change both.
 */

function mergeUsers(rows: UserRow[]): UserRow[] {
  return fold(rows, row => row.user_id, (prev, row) => ({
    ...row,
    first_name: row.first_name ?? prev.first_name,
    phone: row.phone ?? prev.phone,
    access_hash: row.access_hash ?? prev.access_hash,
  }))
}

function mergeChats(rows: ChatRow[]): ChatRow[] {
  return fold(rows, row => row.chat_id, (prev, row) => ({
    ...row,
    title: row.title ?? prev.title,
    username: row.username ?? prev.username,
    access_hash: row.access_hash ?? prev.access_hash,
    participant_count: row.participant_count ?? prev.participant_count,
    migrated_to: row.migrated_to ?? prev.migrated_to,
  }))
}

function mergeMessages(rows: MessageRow[]): MessageRow[] {
  return fold(rows, row => `${row.chat_id}:${row.message_id}`, (prev, row) => ({
    ...row,
    reactions: row.reactions ?? prev.reactions,
  }))
}

/** One row per key, at the key's first position, combined in arrival order. */
function fold<T>(rows: T[], key: (row: T) => string, combine: (prev: T, row: T) => T): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) {
    const k = key(row)
    const prev = byKey.get(k)
    byKey.set(k, prev === undefined ? row : combine(prev, row))
  }
  return [...byKey.values()]
}
