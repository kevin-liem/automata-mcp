import type { Sql } from 'postgres'
import postgres from 'postgres'
import type { AppInstance } from './app-db'
import type { SharedPool } from './pg-pool'
import { staleWhileFailing } from './lookup-cache'
import { meaningfulName, mentionedJidsOf } from './mentions'

/**
 * Read-only access to Evolution's own Postgres — every message this app reads.
 *
 * **Why this exists.** Evolution 2.3.7 cannot search message content. Its
 * `POST /chat/findMessages` looks like it can — the request schema in
 * `src/validate/chat.schema.ts` declares `where.message` as an object — but the
 * field is read exactly zero times in `fetchMessages`. Sending a `where.message`
 * returns the whole unfiltered page, which reads as "these are your matches" and
 * is not. The seven filters it does honour are `id`, `source`, `messageType`,
 * `messageTimestamp` (both bounds or none) and `key.{id,remoteJid,fromMe,participant}`.
 * No other endpoint offers body search. So there is no HTTP route to this.
 *
 * **Why it is dangerous.** Every other credential in this app is scoped to one
 * account: an instance's Evolution token reaches that instance and Evolution
 * enforces it. A database connection reaches *every* user's messages in *every*
 * instance. It is the same shape of risk as the admin-key fallback that
 * `credentialsForInstance()` deliberately refuses. Three rules keep it contained,
 * and none of them is optional:
 *
 *   1. The role is read-only. SELECT on "Message" is what reading and searching
 *      need; status reads add a column-level grant on "Instance" and "instanceId"
 *      on "Chat"/"Contact", group names "remoteJid" and "name" on "Chat", and
 *      both fall back without them (docs/whatsapp.md).
 *      Nothing here writes, and nothing here runs DDL — the schema belongs to
 *      Evolution's Prisma migrations.
 *   2. Every query carries `"instanceId" = <this account>`. `searchMessages`
 *      cannot be called without one; a missing id throws rather than widening.
 *   3. Chat scope is a predicate in the SQL, not a filter applied to rows after
 *      they are read. Out-of-scope messages never enter this process.
 *
 * **This is not optional.** It began as a search-only escape hatch, and now both
 * read paths run through it: Evolution's `findMessages` hands back every stored
 * row, and its history import writes duplicates — one message id can hold two or
 * three rows, disagreeing about who sent it. Collapsing them has to happen before
 * `LIMIT`, which means in SQL. Without `NUXT_EVOLUTION_DATABASE_URL` the MCP
 * surface cannot answer at all.
 *
 * **Why the duplicates exist**, since it decides where the fix belongs: 2.3.7
 * dedupes a history import against an in-memory `Set` of `key.id`, rebuilt from
 * the database at the top of each `messaging-history.set`, and the `createMany`
 * behind it sets `skipDuplicates` — which is inert, because the only unique
 * constraint on `Message` is a `@default(cuid())` primary key that can never
 * collide. So nothing in the schema stops a second write, and two batches in
 * flight together, or an import racing live traffic, both insert. Re-pairing an
 * account (`enableFullHistorySync()`) is what puts them in flight.
 */

/**
 * Whether the *deployment's own* Evolution database is configured.
 *
 * Checked at startup rather than gating a tool: hiding `read-messages` from a
 * client that has already been told the connector reads WhatsApp is a worse
 * answer than an error saying what is missing.
 *
 * It says nothing about a connection that brought its own Evolution server —
 * that one carries its own URL and can read whether or not this is set.
 */
export function messageDatabaseConfigured(): boolean {
  return Boolean(useRuntimeConfig().evolutionDatabaseUrl)
}

/**
 * Whether this connection lives on the Evolution server this deployment
 * configured, as opposed to one the user supplied.
 *
 * The single test, because three things depend on it and the merge that
 * introduced bring-your-own servers already produced one bug from computing it
 * slightly differently in two places. A row carrying its own global key is
 * definitively its own server; so is one pointing somewhere other than our
 * configured URL.
 */
export function onDeploymentServer(instance: Pick<AppInstance, 'admin_key' | 'base_url'>): boolean {
  if (instance.admin_key) return false
  const configUrl = useRuntimeConfig().evolutionUrl
  if (!instance.base_url || !configUrl) return true
  return sameEvolutionServer(instance.base_url, configUrl)
}

/**
 * Which database this account's messages are in, and whether the URL came from
 * a user (and so must be host-guarded and address-pinned).
 *
 * The only place the precedence rule exists. A connection's own
 * `evolution_db_url` wins; otherwise a connection on our server falls back to
 * the deployment's variable; otherwise there is no answer, and the caller
 * refuses rather than querying a database that cannot contain the rows.
 */
export function canReadMessages(instance: AppInstance): boolean {
  return messageDbUrlFor(instance) !== undefined
}

function messageDbUrlFor(instance: AppInstance): { url: string, guard: boolean } | undefined {
  if (instance.evolution_db_url) return { url: instance.evolution_db_url, guard: true }
  if (!onDeploymentServer(instance)) return undefined

  const url = useRuntimeConfig().evolutionDatabaseUrl
  // Ours, on our own network: `net-guard` would (correctly) refuse it as this
  // deployment's own infrastructure, so it is deliberately not guarded.
  return url ? { url, guard: false } : undefined
}

/**
 * The pool for this account's message database.
 *
 * One pool per database URL in play rather than one for the process, because a
 * connection can now bring its own. Everything that makes that safe — the host
 * guard, the address pin, fingerprint invalidation when a URL is rotated, the
 * LRU ceiling — lives in `pg-pool.ts` and is shared with the Postgres
 * connection kind rather than reimplemented here.
 *
 * `statement_timeout` matters more than it looks: Evolution ships
 * `@@index([instanceId])` and nothing else, so reading or searching a large
 * account is a sequential scan. A slow query has to surface as an error the
 * caller can report, not as an MCP call that never returns.
 */
async function evolutionDbFor(instance: AppInstance): Promise<SharedPool> {
  const resolved = resolveMessageDb(instance)
  const sql = await messagePool(instance, resolved)
  // Shared by every account on our own server: one statement in flight per
  // account, so no account's slow reads or searches can hold all three slots.
  return sharedPoolFor(sql, !resolved.guard, `evo:${instance.id}`)
}

/**
 * A failed message-database read, as thrown: a logged 503 — a handled
 * createError is never logged by Nitro, so a 503 would otherwise reach the
 * operator as a response with nothing behind it — except for an error that
 * already carries a status, the per-connection slot's 429 above all, which is
 * an answer and not a database fault.
 */
function readFailure(tag: string, statusMessage: string, error: unknown): unknown {
  if ((error as { statusCode?: number })?.statusCode) return error
  console.error(`${tag} Evolution database query failed:`, error)
  return createError({ statusCode: 503, statusMessage, cause: error })
}

function messagePool(instance: AppInstance, resolved: { url: string, guard: boolean }): Promise<Sql> {
  return keyedPool(
    poolKeyFor(instance, resolved),
    resolved.url,
    { guard: resolved.guard, max: 3, statementTimeoutMs: STATEMENT_TIMEOUT_MS, readOnly: true, jit: false },
  )
}

/**
 * The pool for the two status reads — `readInstanceRecord` and
 * `readInstanceRowWrittenAt`, primary-key lookups the dashboard, MCP status and
 * the alert sweep depend on.
 *
 * Separate from `evolutionDbFor` on our own server so that no amount of message
 * reading or searching by any account can queue an outage check behind it
 * (GHSA-fpmx-gmx5-84vc); a short timeout because a lookup by primary key that
 * takes seconds is a fault worth falling back from. A connection with its own
 * database URL keeps one pool: what queues behind its reads is its own.
 */
async function evolutionStatusDbFor(instance: AppInstance): Promise<Sql> {
  const resolved = resolveMessageDb(instance)
  if (resolved.guard) return await messagePool(instance, resolved)
  return keyedPool('evo:default:status', resolved.url, {
    guard: false, max: 2, statementTimeoutMs: STATUS_STATEMENT_TIMEOUT_MS, readOnly: true, jit: false,
  })
}

const STATUS_STATEMENT_TIMEOUT_MS = 5_000

/** One pool per user-supplied URL; every connection on our own server shares one. */
function poolKeyFor(instance: AppInstance, resolved: { guard: boolean }): string {
  return resolved.guard ? `evo:${instance.id}` : 'evo:default'
}

/** Which message database this connection reads — the key per-database facts are cached under. */
function messagePoolKey(instance: AppInstance): string {
  return poolKeyFor(instance, resolveMessageDb(instance))
}

function resolveMessageDb(instance: AppInstance): { url: string, guard: boolean } {
  const resolved = messageDbUrlFor(instance)

  if (!resolved) {
    if (onDeploymentServer(instance)) {
      // 500, not 503: a missing variable will not resolve itself on a retry, and
      // saying "temporarily" about a deployment that can never answer sends the
      // operator looking for an outage. Logged because a handled createError is
      // not, and this one is the whole diagnosis.
      console.error(
        '[evolution-db] NUXT_EVOLUTION_DATABASE_URL is not set — read-messages and '
        + 'search-messages cannot answer for accounts on this deployment\'s Evolution '
        + 'server. See docs/whatsapp.md "Reading and searching messages".',
      )
      throw createError({
        statusCode: 500,
        statusMessage: 'NUXT_EVOLUTION_DATABASE_URL is not set',
      })
    }

    // A user fixes this one, not an operator, so it names the thing to add.
    // 501 rather than an empty page: this account's messages exist, in a
    // database this app has not been given, and reporting "no messages" would
    // be indistinguishable from an empty conversation.
    throw createError({
      statusCode: 501,
      statusMessage: 'Claude cannot read messages for this account yet. Add your Evolution '
        + 'server\'s database connection string to this connection to enable reading and '
        + 'searching. Pairing, listing chats and sending already work without it.',
    })
  }

  return resolved
}

const STATEMENT_TIMEOUT_MS = 10_000

export async function resolveEvolutionInstanceId(instance: AppInstance): Promise<string> {
  if (instance.instance_id) return instance.instance_id

  const evolution = evolutionClientForInstance(instance)

  let rows: Array<{ id?: string, name?: string }> = []
  try {
    rows = await evolution<Array<{ id?: string, name?: string }>>('/instance/fetchInstances')
  }
  catch (error) {
    // A handled createError is never logged by Nitro; without this the operator
    // sees a 503 with nothing behind it.
    console.error('[search] could not reach Evolution to resolve an instance id:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Could not reach Evolution to identify this WhatsApp account',
      cause: error,
    })
  }

  // An instance token scopes fetchInstances to its own instance, but match on
  // name anyway rather than trusting position.
  const id = (Array.isArray(rows) ? rows.find(row => row?.name === instance.name) : undefined)?.id
  if (!id) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This WhatsApp account is not fully provisioned',
    })
  }

  // Best effort. Search works this time either way; the backfill just saves the
  // round trip next time.
  try {
    await updateRow('instances', instance.id, { instance_id: id })
  }
  catch (error) {
    console.error('[search] could not backfill instance_id:', error)
  }

  return id
}

/**
 * The fields of Evolution's `"Instance"` row a status read needs — the same ones
 * `fetchInstances` used to supply, minus the counts.
 *
 * Named columns, never `*`: the same row carries `token`, the instance's API key,
 * and the optional least-privilege grant in docs/whatsapp.md is column-level for
 * exactly that reason.
 */
export interface EvolutionInstanceRecord {
  connectionStatus?: string
  ownerJid?: string
  profileName?: string
  profilePicUrl?: string
  number?: string
  /** ISO 8601, UTC. */
  disconnectionAt?: string
}

/**
 * When Evolution last wrote this account's `"Instance"` row (its Prisma
 * `@updatedAt`), ISO 8601, UTC — or `undefined` when there is no row or the
 * column is NULL.
 *
 * 2.3.7 writes the row on four occasions only: a socket opening, a QR moving the
 * column to `connecting`, a close it will not retry, and logout cleanup. The
 * last three leave the column something other than `open`, so an `open` row
 * written recently means a socket opened recently — the one signal of a
 * reconnect loop the live state cannot give (see `rowChurn` in instances.ts).
 * Only this SQL read supplies it. `fetchInstances` would, but that path is
 * cached for minutes, which is too coarse to tell a loop from one reconnect.
 *
 * A separate statement from `readInstanceRecord`, not a seventh column there:
 * the least-privilege grant in docs/whatsapp.md is column by column, and a role
 * granted before this column was read would fail that whole query with 42501
 * and push every status read onto `fetchInstances`. Here a missing grant costs
 * only this signal. Same primary-key lookup, same `id = <this account>` rule.
 *
 * Raw driver errors, for the same reason as `readInstanceRecord`.
 */
export async function readInstanceRowWrittenAt(instance: AppInstance): Promise<string | undefined> {
  const sql = await evolutionStatusDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const [row] = await sql<Array<{ updatedAt: Date | null }>>`
    SELECT ("updatedAt" AT TIME ZONE 'UTC') AS "updatedAt"
    FROM "Instance"
    WHERE id = ${instanceId}
  `
  return row?.updatedAt?.toISOString()
}

/**
 * This account's `"Instance"` row, by primary key — or `undefined` when there is
 * no such row.
 *
 * **Why status reads come here instead of `fetchInstances`.** 2.3.7 answers that
 * route with Prisma's `_count: { Message, Contact, Chat }`, which compiles to a
 * `GROUP BY "instanceId"` over *every account's* rows, joined to the one instance
 * afterwards. Each call was a full scan of `"Message"` — 42% of the production
 * database's block reads, growing with every account and every poll. This is an
 * index lookup.
 *
 * `id = <this account>` is this table's form of the `"instanceId"` rule above:
 * `resolveEvolutionInstanceId()` throws rather than hand back an empty id.
 *
 * `disconnectionAt` is a `timestamp` without time zone that Prisma writes and
 * reads as UTC; postgres.js would parse it in the process's local zone, so it is
 * converted to `timestamptz` in the query rather than trusting the host's TZ.
 *
 * Errors are rethrown as the driver raised them — not as a `createError` — so the
 * caller can tell a missing grant (42501) from an outage and fall back.
 */
export async function readInstanceRecord(instance: AppInstance): Promise<EvolutionInstanceRecord | undefined> {
  const sql = await evolutionStatusDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const [row] = await sql<Array<{
    connectionStatus: string | null
    ownerJid: string | null
    profileName: string | null
    profilePicUrl: string | null
    number: string | null
    disconnectionAt: Date | null
  }>>`
    SELECT "connectionStatus"::text AS "connectionStatus",
           "ownerJid",
           "profileName",
           "profilePicUrl",
           "number",
           ("disconnectionAt" AT TIME ZONE 'UTC') AS "disconnectionAt"
    FROM "Instance"
    WHERE id = ${instanceId}
  `
  if (!row) return undefined

  return {
    connectionStatus: row.connectionStatus ?? undefined,
    ownerJid: row.ownerJid ?? undefined,
    profileName: row.profileName ?? undefined,
    profilePicUrl: row.profilePicUrl ?? undefined,
    number: row.number ?? undefined,
    disconnectionAt: row.disconnectionAt?.toISOString(),
  }
}

/**
 * How many `"Message"`, `"Chat"` and `"Contact"` rows this account holds.
 *
 * Raw row counts, duplicates included — the same numbers Prisma's `_count` gave,
 * so the dashboard's figures do not change meaning with this. Each subquery
 * carries `"instanceId" = <this account>`, and all three tables have
 * `@@index([instanceId])`, so this reads one account's rows and nobody else's.
 * Still ~100 ms on an 840k-message account, which is why the caller caches it.
 *
 * Raw driver errors, for the same reason as `readInstanceRecord`.
 */
export async function countInstanceRows(instance: AppInstance): Promise<{ messages: number, chats: number, contacts: number }> {
  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const [row] = await query(sql => sql<Array<{ messages: number, chats: number, contacts: number }>>`
    SELECT (SELECT count(*) FROM "Message" WHERE "instanceId" = ${instanceId})::int AS messages,
           (SELECT count(*) FROM "Chat"    WHERE "instanceId" = ${instanceId})::int AS chats,
           (SELECT count(*) FROM "Contact" WHERE "instanceId" = ${instanceId})::int AS contacts
  `)
  return {
    messages: Number(row?.messages ?? 0),
    chats: Number(row?.chats ?? 0),
    contacts: Number(row?.contacts ?? 0),
  }
}

/**
 * Whether this account has any stored message — the unpaired reaper's question
 * (`pairingEvidence`), which needs a yes or no, not `countInstanceRows`' three
 * counts. One probe of `@@index([instanceId])` however large the account (#156).
 *
 * Raw driver errors, for the same reason as `readInstanceRecord`.
 */
export async function hasInstanceMessages(instance: AppInstance): Promise<boolean> {
  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const [row] = await query(sql => sql<Array<{ found: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "Message" WHERE "instanceId" = ${instanceId}) AS found
  `)
  return row?.found === true
}

export interface MessageSearchOptions {
  /** Every term must appear in the message body. Already split, not yet escaped. */
  terms: string[]
  /**
   * Restrict to one conversation: the chat's JID, or both JIDs of a linked
   * person (`whatsapp-identity.ts`), already cut to scope by `expandChat`.
   * Emitted whenever present — an empty array matches nothing rather than
   * widening to every chat.
   */
  jids?: readonly string[]
  /** The only chats this token may see. Omit for an all-chats token. */
  allowedJids?: string[]
  since?: string
  until?: string
  fromMe?: boolean
  /**
   * Match reaction messages too.
   *
   * Defaults to false, which is what this query has always done — before the
   * `reactionMessage` arm below existed a reaction row produced no `body` at all
   * and `body IS NOT NULL` dropped it. Silently, rather than by decision. The
   * default keeps that outcome and makes it a choice.
   */
  includeReactions?: boolean
  limit: number
}

export interface MessageSearchHit {
  jid: string
  id?: string
  fromMe: boolean
  /**
   * Who sent it, unresolved: the sender's JID and the push name stored beside it.
   *
   * Turned into a display name by the caller, for the same reason `mentioned` is
   * — both need the same directory, and the tool is what decides how much of one
   * to pay for. `pushName` is never an answer on its own; see `authorName` in
   * `mentions.ts`.
   */
  sender: { identity?: string, pushName?: string }
  timestamp?: string
  type?: string
  text: string
  /**
   * JIDs this message mentions, for the caller to resolve to names.
   *
   * Left unresolved here on purpose: a hit set spans arbitrarily many chats, and
   * naming a group's members is a live round trip per group. The tool decides how
   * much of that to pay — see `search-messages.ts`.
   */
  mentioned: string[]
  /**
   * The `id` of the message this hit edits, when it is an edit.
   *
   * WhatsApp delivers an edit as its own record and never rewrites the original,
   * so the message it replaces may be a separate hit in the same result set,
   * still carrying its old text. Prefer this one when the two disagree.
   */
  editOf?: string
}

export async function searchMessages(
  instance: AppInstance,
  options: MessageSearchOptions,
): Promise<{ hits: MessageSearchHit[], truncated: boolean }> {
  assertSearchTerms(options.terms)
  // Database first, deliberately. `resolveEvolutionInstanceId` may call the
  // account's Evolution API, and its 409/503 would otherwise mask the clearer
  // "add your database connection string" refusal for a connection that can
  // never read — and would pay for a round trip to learn nothing.
  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const since = toUnixSeconds(options.since, 'since')
  const until = toUnixSeconds(options.until, 'until')

  // One extra row tells us there were more matches than we returned, for a
  // fraction of the cost of a second COUNT(*) over the same scan.
  const take = options.limit + 1

  let rows: MessageRow[]
  try {
    // `DISTINCT ON (key->>'id')` is what stops one message being reported as two
    // or three matches; `bestNamed` decides which of the duplicate rows survives.
    // It has to run before `LIMIT`, so the dedupe is a CTE and the ordering the
    // caller sees is applied outside it.
    //
    // The `reactionMessage` arm in the COALESCE is what makes an emoji findable
    // at all; the predicate near the bottom is what keeps reactions out by
    // default. That predicate reads the payload rather than `messageType`,
    // because `messageType` is Baileys' `getContentType()` verbatim — the *first*
    // key of the payload that is `conversation` or ends in `Message` — so a
    // reaction arriving alongside a `messageContextInfo` is stored under that
    // type instead, with `message.reactionMessage` sitting right there. The
    // payload is the authority. It is checked only on rows the body match
    // already admitted. None of it touches scope: `instanceId`, `jid` and
    // `allowedJids` still bound the query, so an included reaction is only ever
    // one from a chat this token already reaches.
    //
    // The body is matched through `bodyMatchesAll`, never `ILIKE ALL` on a
    // lateral alias: that shape can't use the trigram index docs/whatsapp.md
    // tells operators to build, so every search read every row of the account
    // (#202).
    //
    // `jids` may name two JIDs — one person stored under a LID and a phone
    // number. `DISTINCT ON (key->>'id')` and everything outside the CTE are
    // unchanged by that: they already run over whatever the predicate admits.
    rows = await query(sql => sql<MessageRow[]>`
      WITH matched AS (
        SELECT DISTINCT ON (m.key->>'id')
               m.key, m."pushName", m."messageType", m."messageTimestamp", ${messageBody(sql)} AS body,
               m."contextInfo"->'mentionedJid' AS mentioned,
               -- Which message this one edits, when it is an edit. Not decoration:
               -- without it a search can return both the stale original and its
               -- edit, with different text and no way to tell which is current.
               -- The alias quoting is load-bearing — unquoted, postgres.js folds it
               -- to editof and the field is silently always undefined.
               COALESCE(
                 m.message->'protocolMessage'->'key'->>'id',
                 m.message->'associatedChildMessage'->'message'->'protocolMessage'->'key'->>'id'
               ) AS "editOf",
               ${bestNamed(sql)} AS named, m.id AS "rowId"
        FROM "Message" m
        WHERE m."instanceId" = ${instanceId}
          AND ${messageBody(sql)} IS NOT NULL
          ${bodyMatchesAll(sql, options.terms)}
          ${options.jids === undefined ? sql`` : sql`AND m.key->>'remoteJid' = ANY(${[...options.jids]}::text[])`}
          ${options.allowedJids ? sql`AND m.key->>'remoteJid' = ANY(${options.allowedJids}::text[])` : sql``}
          ${since === undefined ? sql`` : sql`AND m."messageTimestamp" >= ${since}`}
          ${until === undefined ? sql`` : sql`AND m."messageTimestamp" <= ${until}`}
          ${options.fromMe === undefined ? sql`` : sql`AND (m.key->>'fromMe')::boolean = ${options.fromMe}`}
          ${options.includeReactions ? sql`` : sql`AND m.message->'reactionMessage' IS NULL`}
          -- Control records are excluded by intent, not only by accident. Today
          -- this is a no-op: no arm above reads anything out of a non-edit
          -- protocolMessage, so such a row has no body and body IS NOT NULL
          -- already dropped it. It is here so a future arm cannot quietly start
          -- surfacing bookkeeping. It cannot drop an unwrapped edit — any row
          -- whose body came from the edit arms has editedMessage non-null. Never
          -- let this grow into something that inspects where the body came from;
          -- that is where it would start dropping real edits.
          AND (m.message->'protocolMessage' IS NULL
               OR m.message->'protocolMessage'->'editedMessage' IS NOT NULL)
        ORDER BY m.key->>'id', named DESC, m."messageTimestamp" DESC, "rowId"
      )
      SELECT key, "pushName", "messageType", "messageTimestamp", body, mentioned, "editOf"
      FROM matched
      ORDER BY "messageTimestamp" DESC, key->>'id' DESC
      LIMIT ${take}
    `)
  }
  catch (error) {
    throw readFailure('[search]', 'Message search is temporarily unavailable', error)
  }

  const truncated = rows.length > options.limit

  return {
    hits: rows.slice(0, options.limit).map(row => ({
      jid: row.key?.remoteJid ?? '',
      id: row.key?.id,
      fromMe: Boolean(row.key?.fromMe),
      sender: senderOf(row),
      timestamp: row.messageTimestamp
        ? new Date(Number(row.messageTimestamp) * 1000).toISOString()
        : undefined,
      type: row.messageType ?? undefined,
      text: row.body,
      mentioned: mentionedJidsOf(row.mentioned),
      ...(row.editOf && { editOf: row.editOf }),
    })),
    truncated,
  }
}

export interface MessagePageOptions {
  /**
   * The one conversation to read: a chat's JID, or both JIDs of a person stored
   * under a LID and a phone number (`whatsapp-identity.ts`), already cut to the
   * token's scope. A predicate in the SQL, never a filter over rows read.
   *
   * Absent means the whole account, which exists for the **session** surface —
   * the dashboard's message table — and is unreachable from MCP: every tool goes
   * through `listMessages()` in `chats.ts`, which takes a non-empty tuple of
   * JIDs as a required positional argument, so no tool can widen to every chat
   * by omitting a field. The predicate is emitted whenever this is present, so
   * an empty array matches nothing rather than everything. `instanceId` below
   * is unconditional either way.
   */
  jids?: readonly string[]
  limit: number
  /** 1-based, counting back from the newest. */
  page: number
  since?: string
  until?: string
  includeReactions?: boolean
  /**
   * Every term must appear in the message body. Already split, not yet escaped —
   * matched by the same `bodyMatchesAll` over the same `messageBody` expression
   * `searchMessages` uses, so a listing and a search agree on what the text of a
   * message is, and both can use the trigram index.
   */
  terms?: string[]
  /** Which end of the range the first page comes from. Defaults to newest first. */
  order?: 'newest' | 'oldest'
}

/**
 * One stored message, still in Evolution's shape.
 *
 * Deliberately not `ChatMessage`: rendering a payload and naming a sender both
 * belong to `chats.ts`, which owns `previewOf` and the name directory. This module
 * reads rows and nothing else.
 */
export interface MessageRecord {
  key: MessageKey | null
  pushName: string | null
  messageType: string | null
  /** Unix seconds — the column is an `Int`, and never null. */
  messageTimestamp: number | null
  message: unknown
  mentioned: string[] | null
}

/**
 * One page of a chat's history, deduplicated, newest first.
 *
 * This replaced `POST /chat/findMessages`, which cannot do the one thing that
 * matters here. Evolution's `Message` table holds two or three rows for a single
 * message across a re-pair, and its endpoint pages with `skip`/`take` over those
 * rows — so a caller asking for 50 messages got 50 *rows*, perhaps 20 distinct
 * ones, and a `total` that counted every copy. Collapsing after the fact cannot
 * fix either: the page boundaries were already drawn in the wrong place. Hence
 * `DISTINCT ON` inside a CTE, with `LIMIT`/`OFFSET` applied to what comes out.
 *
 * Reading one person across two JIDs changes none of it. The predicate admits
 * both JIDs' rows; the dedupe, the count, the over-fetch and the tiebreak then
 * run over the union exactly as over one chat, so pages stay disjoint and
 * `total` counts distinct messages across both.
 *
 * Two details in the ordering carry weight. `bestNamed` makes the surviving row of
 * a duplicate set deterministic — otherwise a message's author changes between
 * identical calls. And the outer sort breaks ties on the message id, which
 * Evolution's own `orderBy: { messageTimestamp: 'desc' }` does not: without a
 * tiebreaker, rows sharing a timestamp can appear on two pages or on neither.
 */
export async function listMessagesPage(
  instance: AppInstance,
  options: MessagePageOptions,
): Promise<{ records: MessageRecord[], hasMore: boolean, total?: number }> {
  if (options.terms) assertSearchTerms(options.terms)
  // Database first, deliberately. `resolveEvolutionInstanceId` may call the
  // account's Evolution API, and its 409/503 would otherwise mask the clearer
  // "add your database connection string" refusal for a connection that can
  // never read — and would pay for a round trip to learn nothing.
  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const since = toUnixSeconds(options.since, 'since')
  const until = toUnixSeconds(options.until, 'until')

  // Same over-fetch trick as `searchMessages`, and `hasMore` still comes from it
  // rather than from `total`, even though `total` is now exact. A count that went
  // wrong upstream must never be able to drive a caller into paging forever.
  const take = options.limit + 1
  const skip = (options.page - 1) * options.limit

  // Matched only when there is something to match, so an ordinary read pays
  // nothing for it. The body expression is shared with `searchMessages`.
  const terms = options.terms?.length ? options.terms : undefined

  // The tiebreaker travels with the direction. Evolution's own ordering has
  // none, and rows sharing a timestamp then land on two pages or on neither —
  // reversing one half of the pair would reintroduce exactly that.
  const ordering = (sql: Sql) => options.order === 'oldest'
    ? sql`"messageTimestamp" ASC, key->>'id' ASC`
    : sql`"messageTimestamp" DESC, key->>'id' DESC`

  let rows: MessagePageRow[]
  try {
    rows = await query(sql => sql<MessagePageRow[]>`
      WITH deduped AS (
        SELECT DISTINCT ON (m.key->>'id')
               m.key, m."pushName", m."messageType", m."messageTimestamp", m.message,
               m."contextInfo"->'mentionedJid' AS mentioned,
               ${bestNamed(sql)} AS named, m.id AS "rowId"
        FROM "Message" m
        WHERE m."instanceId" = ${instanceId}
          ${options.jids === undefined ? sql`` : sql`AND m.key->>'remoteJid' = ANY(${[...options.jids]}::text[])`}
          ${terms === undefined ? sql`` : bodyMatchesAll(sql, terms)}
          ${since === undefined ? sql`` : sql`AND m."messageTimestamp" >= ${since}`}
          ${until === undefined ? sql`` : sql`AND m."messageTimestamp" <= ${until}`}
          ${options.includeReactions ? sql`` : sql`AND m.message->'reactionMessage' IS NULL`}
        ORDER BY m.key->>'id', named DESC, m."messageTimestamp" DESC, "rowId"
      )
      SELECT key, "pushName", "messageType", "messageTimestamp", message, mentioned,
             COUNT(*) OVER () AS total
      FROM deduped
      ORDER BY ${ordering(sql)}
      LIMIT ${take} OFFSET ${skip}
    `)
  }
  catch (error) {
    throw readFailure('[read]', 'Reading messages is temporarily unavailable', error)
  }

  // The window function counts the deduped set, so this is the number of distinct
  // messages in the range — not of rows, and not of the chat. It rides on the
  // returned rows, so a page past the end carries no count rather than a zero:
  // "I did not measure" and "there are none" are different answers.
  const total = Number(rows[0]?.total)

  return {
    records: rows.slice(0, options.limit).map(({ total: _total, ...record }) => record),
    hasMore: rows.length > options.limit,
    total: Number.isFinite(total) ? total : undefined,
  }
}

/**
 * One conversation's activity, as the chat listing needs it.
 *
 * Rows only, like everything here: naming the chat and previewing its last
 * message belong to `chats.ts`.
 */
export interface ChatActivityRow {
  /** The conversation's id: a linked person's LID, else the chat's own JID. */
  jid: string
  /**
   * Every stored JID folded into this row, sorted. One element for an ordinary
   * chat; two for a person stored under a LID and a phone number.
   */
  jids: string[]
  /** Unix seconds of the newest message that is not a control record. */
  lastTimestamp: number | null
  /** `"Message".id` of that message, for `lastMessagePayloads`. */
  lastRowId: string | null
}

/**
 * The account's conversations, most recent activity first — **all of them**, in
 * one read. Paging is the caller's: `chats.ts` keeps this answer for a minute
 * (`sharedCache`) and slices pages out of it, so walking the listing page by page
 * costs one read, not one per page (#174).
 *
 * **This replaced `POST /chat/findChats`**, which is itself a raw
 * `DISTINCT ON (remoteJid)` over this table.
 *
 * **No unread count, on purpose.** Evolution's `Chat.unreadMessages` reads 0
 * almost always — 2.3.7's `messages.update` handler writes 0 on *any* status
 * update in the chat. Deriving it here was tried and measured wrong: the signal
 * that a chat was read on the phone is the app-state `chats.update` carrying
 * `unreadCount: 0`, and 2.3.7's handler for it writes only `remoteJid` and
 * forwards only `remoteJid` in its webhook, so that fact is never stored. Message
 * `READ` statuses arrive too sporadically to stand in for it (a test account with
 * zero unread badges on the phone computed 651 unread). A field that is always
 * wrong is worse than none: an agent asked "anything unread?" should say it
 * cannot tell. Re-check if Evolution starts persisting `chats.update`.
 *
 * **Cost: proportional to chats, not messages — given the index (#174).** With
 * an index on `("instanceId", key->>'remoteJid', "messageTimestamp")` —
 * `message_instance_chat_ts_idx` in docs/whatsapp.md, `message_chat_ts_idx` on
 * production; any name or direction — the read is a loose index scan: a recursive CTE walks the
 * account's distinct `remoteJid`s one index descent each, then for each chat
 * reads its newest rows backwards off the same index and keeps the first that
 * is not a control record — usually the first. Measured on production (PG 17,
 * `"Message"` at 7M rows): 1.9M-message account, 3,217 chats, 96 ms warm and
 * 2.4 s cold; the full aggregate below timed out at 10 s there. The jid walk
 * alone is ~30 ms; the cold cost is one heap visit per chat.
 *
 * **Without that index the full aggregate is kept**, not the skip-scan: the
 * per-chat lookup would then sort every chat's rows through a random-access
 * index walk, which is worse than one sequential pass. `chatTimestampIndexPresent`
 * decides, by the index's shape. The aggregate's shape is load-bearing, measured
 * on an 840k-message account: Postgres has no statistics on
 * `key->>'remoteJid'`, guesses one chat per row and groups by *sorting*; fed raw
 * rows that sort carried each row's whole jsonb and spilled ~540 MB (91 s). The
 * `MATERIALIZED` CTE reduces every row to scalars first and is a fence — do not
 * fold `msg` into `per_jid`.
 *
 * Both shapes produce one `per_jid` row per stored JID with the same answer —
 * verified on production with `EXCEPT` both ways (zero differences) and on
 * synthetic ties and missing ids locally. The newest row is by timestamp, then
 * `mid || '|' || row_id` as one string — exactly the order of the fallback's
 * padded `last_key`, under the same collation. A chat holding only control
 * records keeps its row with no timestamp.
 *
 * Neither opens `message` for every row: the payload is TOASTed. `notControl`
 * opens it only for rows whose `messageType` can carry a control record — see
 * there. The last message's payload is *not* read here; `lastMessagePayloads`
 * fetches it by primary key for the rows actually returned.
 *
 * `status@broadcast` is left out: it is Status updates, not a conversation, and
 * nothing can be sent to it.
 *
 * **A linked person is one row, merged here.** The links (`lidLinks`) arrive as
 * two bind arrays and join onto the per-JID result — a few thousand rows at
 * most. The newest row still comes from the same padded-key `max()`, now over
 * both halves.
 */
export async function listChatActivity(
  instance: AppInstance,
  /**
   * Phone-number JID → LID, from `lidLinks()`. Each phone-number chat named
   * here is folded into its LID's row, so the listing counts people, not
   * storage keys. Omitted or empty: every JID is its own row, as before.
   */
  links?: ReadonlyMap<string, string>,
): Promise<ChatActivityRow[]> {
  // Database first, for the same reason as `listMessagesPage`.
  const { query } = await evolutionDbFor(instance)
  const [instanceId, skipScan] = await Promise.all([
    resolveEvolutionInstanceId(instance),
    chatTimestampIndexPresent(instance, query),
  ])

  const pns = [...(links?.keys() ?? [])]
  const lids = [...(links?.values() ?? [])]

  let rows: ChatActivityRow[]
  try {
    rows = await query(sql => sql`
      WITH RECURSIVE ${skipScan ? perJidBySkipScan(sql, instanceId) : perJidByAggregate(sql, instanceId)},
      per_chat AS (
        SELECT COALESCE(l.lid, p.jid) AS jid,
               array_agg(p.jid ORDER BY p.jid) AS jids,
               max(p.last_ts) AS last_ts,
               split_part(max(p.last_key), '|', 3) AS last_row_id
        FROM per_jid p
        LEFT JOIN unnest(${pns}::text[], ${lids}::text[]) AS l(pn, lid) ON l.pn = p.jid
        GROUP BY 1
      )
      SELECT jid,
             jids,
             last_ts AS "lastTimestamp",
             NULLIF(last_row_id, '') AS "lastRowId"
      FROM per_chat
      ORDER BY last_ts DESC NULLS LAST, jid
    `)
  }
  catch (error) {
    throw readFailure('[chats]', 'Listing conversations is temporarily unavailable', error)
  }

  return rows.map(row => ({
    ...row,
    lastTimestamp: row.lastTimestamp === null ? null : Number(row.lastTimestamp),
  }))
}

/**
 * `per_jid` from a loose index scan over the per-chat timestamp index — see
 * `listChatActivity`. Two CTEs, `jids` (recursive) then `per_jid`.
 *
 * The jid walk asks the index for the smallest `remoteJid` above the last one,
 * one descent per chat; `IS NOT NULL` on the first step and `>` on the rest keep
 * NULL out. Postgres 17 has no skip scan of its own, hence the recursion.
 */
function perJidBySkipScan(sql: Sql, instanceId: string) {
  return sql`
    jids AS (
      (SELECT m.key->>'remoteJid' AS jid
       FROM "Message" m
       WHERE m."instanceId" = ${instanceId}
         AND m.key->>'remoteJid' IS NOT NULL
       ORDER BY m.key->>'remoteJid'
       LIMIT 1)
      UNION ALL
      SELECT (SELECT m.key->>'remoteJid'
              FROM "Message" m
              WHERE m."instanceId" = ${instanceId}
                AND m.key->>'remoteJid' > j.jid
              ORDER BY m.key->>'remoteJid'
              LIMIT 1)
      FROM jids j
      WHERE j.jid IS NOT NULL
    ), per_jid AS (
      SELECT j.jid,
             last.ts AS last_ts,
             lpad(last.ts::text, 10, '0') || '|' || last.mid || '|' || last.row_id AS last_key
      FROM jids j
      LEFT JOIN LATERAL (
        SELECT m."messageTimestamp" AS ts,
               COALESCE(m.key->>'id', '') AS mid,
               m.id AS row_id
        FROM "Message" m
        WHERE m."instanceId" = ${instanceId}
          AND m.key->>'remoteJid' = j.jid
          AND ${notControl(sql)}
        -- Same order as the fallback's padded-key max(): the timestamp, then
        -- the rest of that key compared as one string under its collation.
        -- Not "mid DESC, row_id DESC": a collation that skips '|' orders a
        -- missing id differently once it is a separate column.
        ORDER BY m."messageTimestamp" DESC, (COALESCE(m.key->>'id', '') || '|' || m.id) DESC
        LIMIT 1
      ) last ON true
      WHERE j.jid IS NOT NULL
        AND j.jid <> 'status@broadcast'
    )
  `
}

/**
 * `per_jid` from one aggregate over every row of the account — the shape used
 * before #174, kept for a database without the per-chat timestamp index. See
 * `listChatActivity` for why `msg` is a fenced CTE.
 */
function perJidByAggregate(sql: Sql, instanceId: string) {
  return sql`
    msg AS MATERIALIZED (
      SELECT m.key->>'remoteJid' AS jid,
             m."messageTimestamp" AS ts,
             COALESCE(m.key->>'id', '') AS mid,
             m.id AS row_id,
             ${notControl(sql)} AS is_activity
      FROM "Message" m
      WHERE m."instanceId" = ${instanceId}
        AND m.key->>'remoteJid' IS NOT NULL
        AND m.key->>'remoteJid' <> 'status@broadcast'
    ), per_jid AS (
      SELECT jid,
             max(ts) FILTER (WHERE is_activity) AS last_ts,
             max(lpad(ts::text, 10, '0') || '|' || mid || '|' || row_id)
               FILTER (WHERE is_activity) AS last_key
      FROM msg
      GROUP BY jid
    )
  `
}

/**
 * Whether this message database has an index `listChatActivity` can skip-scan:
 * a valid, non-partial btree on `("instanceId", (key->>'remoteJid'),
 * "messageTimestamp")`, by **shape**, so an operator's own name for it counts.
 * `DESC` on the last column matches too (the prefix is the same; a backward
 * scan reads either).
 *
 * Evolution creates no such index; docs/whatsapp.md tells the operator to. So
 * this is per database (`evo:default` or the connection's own), cached ten
 * minutes — an index built while running is picked up without a restart — and
 * a failed check reads as "absent" for a minute, which falls back to the shape
 * that works everywhere rather than gambling on one that needs the index.
 * Absence is logged once per database per process.
 */
async function chatTimestampIndexPresent(instance: AppInstance, query: SharedPool['query']): Promise<boolean> {
  const key = messagePoolKey(instance)

  return await chatIndexCache(key, async () => {
    let present: boolean
    try {
      const [row] = await query(sql => sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_index i
          WHERE i.indrelid = to_regclass('"Message"')
            AND i.indisvalid
            AND i.indisready
            AND i.indpred IS NULL
            AND pg_get_indexdef(i.indexrelid) LIKE ${CHAT_TS_INDEX_SHAPE}
        ) AS present
      `)
      present = row?.present === true
    }
    catch (error) {
      console.warn('[chats] could not check "Message" for the chat listing index; listing by full scan for now:', error)
      return undefined
    }

    if (!present && !chatIndexMissingReported.has(key)) {
      chatIndexMissingReported.add(key)
      console.warn(
        '[chats] "Message" has no index on ("instanceId", (key->>\'remoteJid\'), "messageTimestamp"), '
        + 'so every chat listing reads all of an account\'s messages and large accounts time out. '
        + 'Create message_instance_chat_ts_idx: see docs/whatsapp.md "Indexes on Evolution\'s tables".',
      )
    }
    if (present) chatIndexMissingReported.delete(key)
    return present
  })
}

/** What `pg_get_indexdef` prints for that index, up to the last column. No `_` or `%` inside. */
const CHAT_TS_INDEX_SHAPE = '%USING btree ("instanceId", ((key ->> \'remoteJid\'::text)), "messageTimestamp"%'

const chatIndexCache = staleWhileFailing<boolean>({ ttlMs: 10 * 60_000, retryTtlMs: 60_000, empty: false })
const chatIndexMissingReported = new Set<string>()

/**
 * One `(remoteJid, remoteJidAlt)` combination seen on a LID chat's rows.
 *
 * `alt` is null for a LID chat whose rows never carried one — those rows are
 * still returned, once per chat, so the caller can count LID chats that have
 * no link at all. Raw, as stored: `whatsapp-identity.ts` decides which of these
 * is a pair it will act on.
 */
export interface LidLinkRow {
  jid: string
  alt: string | null
}

/**
 * The LID ↔ phone-number links WhatsApp itself revealed on this account's
 * messages, for `whatsapp-identity.ts`.
 *
 * **Only `key.remoteJidAlt` on LID chats' own rows.** Baileys sets it on live traffic and
 * history sync never does (#116), so this is partial by construction. It is the
 * only source on purpose: Evolution's `"IsOnWhatsapp"` holds a `lid` column too,
 * but that table has no `instanceId` — it is one cache filled by every account
 * on the server, and reading pairs from it would show one tenant what another
 * tenant's lookups learned. `"Contact"` holds no pairing at all. Group rows'
 * `participantAlt` is left out: measured, it linked no 1:1 chat the chat's own
 * rows did not, and merging two 1:1 chats on evidence from group rows would make
 * a chat-scoped token's view depend on chats outside its scope — the same reason
 * a phone-number chat's rows are not read for the reverse link.
 *
 * One scan of the account (`instanceId` is the only index), grouped down to
 * distinct combinations, so the result is small — a few rows per person, never
 * per message. Cached by the caller; never on a per-message path.
 */
export async function readLidLinks(instance: AppInstance): Promise<LidLinkRow[]> {
  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  return await query(sql => sql<LidLinkRow[]>`
    SELECT m.key->>'remoteJid' AS jid, m.key->>'remoteJidAlt' AS alt
    FROM "Message" m
    WHERE m."instanceId" = ${instanceId}
      AND m.key->>'remoteJid' LIKE '%@lid'
    GROUP BY 1, 2
  `)
}

/**
 * `"Chat".name` for every group chat of this account, keyed by group JID —
 * `undefined` where Evolution stored no usable name. For `whatsapp-groups.ts`,
 * which states how stale this column can be and why (written once, never on a
 * rename).
 *
 * `"Chat"` carries `@@index([instanceId])` and one row per conversation, so this
 * is a small indexed read, never a scan of `"Message"`. Three named columns —
 * the optional grant in docs/whatsapp.md is column by column.
 *
 * Raw driver errors, for the same reason as `readInstanceRecord`: a missing
 * grant (42501) is told apart from an outage by the caller.
 */
export async function readGroupChatNames(instance: AppInstance): Promise<Map<string, string | undefined>> {
  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const rows = await query(sql => sql<Array<{ remoteJid: string, name: string | null }>>`
    SELECT "remoteJid", name
    FROM "Chat"
    WHERE "instanceId" = ${instanceId}
      AND "remoteJid" LIKE '%@g.us'
  `)

  // A group named after its own id is no name at all.
  return new Map(rows.map(row => [row.remoteJid, meaningfulName(row.name, row.remoteJid.split('@')[0]!)]))
}

/**
 * The payloads of the given rows, keyed by `"Message".id` — the last message of
 * each chat on one page of the listing.
 *
 * Separate from `listChatActivity` so a listing that names and sorts thousands
 * of chats in memory pays for payloads only on the page it returns. Still bound
 * by `instanceId`, so an id from anywhere else reads nothing.
 */
export async function lastMessagePayloads(instance: AppInstance, rowIds: string[]): Promise<Map<string, unknown>> {
  if (!rowIds.length) return new Map()

  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const rows = await query(sql => sql<Array<{ id: string, message: unknown }>>`
    SELECT id, message FROM "Message"
    WHERE "instanceId" = ${instanceId} AND id = ANY(${rowIds}::text[])
  `)

  return new Map(rows.map(row => [row.id, row.message]))
}

export interface LidLocalPartOptions {
  /** Only messages with `messageTimestamp` (unix seconds) at or after this. */
  since?: number
  /** Only this local part: answers with it, or with an empty set. */
  localPart?: string
}

/**
 * The local parts of every LID (`…@lid`) this account's messages name — as a
 * chat, as a group sender, as either one's alternate form, or as an @-mention.
 *
 * For `assertNotBareLid` (`lid-guard.ts`): these are exactly the identifiers the
 * read tools can put in front of a model, so they are the digits a model might
 * strip a suffix from and pass back as a phone number. `"Message"` only, never
 * `"Chat"` or `"Contact"`, because the optional `wamcp_search` grant covers this
 * table and only `"instanceId"` on those two.
 *
 * A device suffix (`79972425314508:12@lid`) is cut along with the domain, so the
 * answer is the digits a caller would see.
 *
 * Cost: one scan of the account's rows (`@@index([instanceId])` is the only
 * index). The lateral yields only short text values, so the `DISTINCT` hashes a
 * few thousand strings rather than sorting jsonb — none of `listChatActivity`'s
 * spill. `since` and `localPart` narrow what is extracted, not what is read; with
 * `localPart` the query stops at the first hit. `mentionedJid` is checked to be
 * an array before it is expanded, since `jsonb_array_elements_text` throws on
 * anything else and one odd row must not fail the whole read.
 *
 * Raw driver errors: the caller decides what an unreadable answer means.
 */
export async function lidLocalParts(instance: AppInstance, options: LidLocalPartOptions = {}): Promise<Set<string>> {
  const { query } = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const rows = await query(sql => sql<Array<{ lid: string }>>`
    SELECT DISTINCT split_part(split_part(ids.jid, '@', 1), ':', 1) AS lid
    FROM "Message" m
    CROSS JOIN LATERAL (
      SELECT m.key->>'remoteJid'
      UNION ALL SELECT m.key->>'participant'
      UNION ALL SELECT m.key->>'remoteJidAlt'
      UNION ALL SELECT m.key->>'participantAlt'
      UNION ALL SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(m."contextInfo"->'mentionedJid') = 'array'
             THEN m."contextInfo"->'mentionedJid' END
      )
    ) AS ids(jid)
    WHERE m."instanceId" = ${instanceId}
      ${options.since !== undefined ? sql`AND m."messageTimestamp" >= ${options.since}` : sql``}
      AND ids.jid LIKE '%@lid'
      ${options.localPart !== undefined
        ? sql`AND split_part(split_part(ids.jid, '@', 1), ':', 1) = ${options.localPart} LIMIT 1`
        : sql``}
  `)

  return new Set(rows.map(row => row.lid).filter(Boolean))
}

/**
 * Not a WhatsApp control record. An edit is kept: in history-synced data it is
 * the only copy of the new text, so it is real activity in the chat.
 *
 * **`messageType` decides whether to look; the payload still decides (#128).**
 * `message` is the whole WhatsApp payload, usually stored out of line (TOAST),
 * so reading it for every row of an account is what made `listChatActivity`
 * cost ~750 MB of reads on a 310k-message account and time out cold. Only the
 * two types that can carry a control record open the payload: `protocolMessage`,
 * and `messageContextInfo`, because Baileys' `getContentType()` returns the
 * *first* key and a wrapper can come first. Every other type is activity
 * without looking — measured: no row typed otherwise had `protocolMessage` in
 * its payload. `CASE`, never `OR`: Postgres does not promise to short-circuit
 * `OR`, so the payload arm could still be evaluated for every row.
 *
 * Used by `listChatActivity` only. The other payload checks (search's control
 * filter, the reaction filters) have not been measured with this shape; widen
 * it to them one at a time, each with its own evidence. Re-run the type check
 * in CLAUDE.md on an Evolution tag bump.
 */
function notControl(sql: Sql) {
  return sql`(CASE WHEN m."messageType" IN ('protocolMessage', 'messageContextInfo')
                   THEN (m.message->'protocolMessage' IS NULL
                         OR m.message->'protocolMessage'->'editedMessage' IS NOT NULL)
                   ELSE true
              END)`
}

/**
 * The readable text of a message, as an expression over `m` — null for a row
 * that carries nothing renderable.
 *
 * One authority for what counts as a body, shared by `searchMessages` (which
 * selects and matches on it) and `listMessagesPage` (which matches on it only
 * when there are terms). Two copies of this COALESCE would drift, and a search
 * that reads one definition while a listing reads another is a set of results
 * that cannot be paged.
 *
 * **This text is also the definition of `message_body_trgm`**, the trigram
 * index docs/whatsapp.md has operators build on `"Message"` (#202). Postgres
 * uses an expression index only when the query's expression is identical to
 * it, so changing an arm here (adding, removing, reordering) without changing
 * the documented index makes every search read the whole account again —
 * silently, with the same results. Change both together and say so in the
 * release notes, since operators have to rebuild it. Inlined where it is used
 * rather than behind a `LATERAL` alias, so matching the index never depends on
 * the planner flattening a subquery.
 */
function messageBody(sql: Sql) {
  return sql`COALESCE(
        m.message->>'conversation',
        m.message->'extendedTextMessage'->>'text',
        m.message->'imageMessage'->>'caption',
        m.message->'videoMessage'->>'caption',
        m.message->'documentMessage'->>'caption',
        m.message->'documentWithCaptionMessage'->'message'->'documentMessage'->>'caption',
        m.message->>'speechToText',
        m.message->'reactionMessage'->>'text',
        -- Album media and captioned video from an official WhatsApp client
        -- arrive wrapped: associatedChildMessage is a FutureProofMessage,
        -- a transparent { message: Message }, which the rc.9 Baileys that
        -- 2.3.7 pins does not unwrap. Explicit paths only — a $.** recursive
        -- jsonb path would also match contextInfo.quotedMessage.conversation
        -- and make a reply findable by the text it quoted, which is
        -- misattribution by construction.
        m.message->'associatedChildMessage'->'message'->>'conversation',
        m.message->'associatedChildMessage'->'message'->'extendedTextMessage'->>'text',
        m.message->'associatedChildMessage'->'message'->'imageMessage'->>'caption',
        m.message->'associatedChildMessage'->'message'->'videoMessage'->>'caption',
        m.message->'associatedChildMessage'->'message'->'documentMessage'->>'caption',
        -- A plaintext edit (protocolMessage.type = 14). In history-synced
        -- data this row is the ONLY copy of the edited text — nothing patches
        -- the original — so without these arms the new wording is unfindable.
        m.message->'protocolMessage'->'editedMessage'->>'conversation',
        m.message->'protocolMessage'->'editedMessage'->'extendedTextMessage'->>'text',
        m.message->'protocolMessage'->'editedMessage'->'imageMessage'->>'caption',
        m.message->'protocolMessage'->'editedMessage'->'videoMessage'->>'caption',
        m.message->'protocolMessage'->'editedMessage'->'documentMessage'->>'caption',
        -- Both at once: a caption edit on an album item.
        m.message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->>'conversation',
        m.message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'extendedTextMessage'->>'text',
        m.message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'imageMessage'->>'caption',
        m.message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'videoMessage'->>'caption',
        m.message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'documentMessage'->>'caption'
        -- speechToText and reactionMessage are not repeated in the nested
        -- groups: Evolution writes the first at top level only, and a reaction
        -- is never an album child or an edit target. COALESCE short-circuits,
        -- so an ordinary text row still stops at the first arm — the extra
        -- lookups are paid only by rows that produce no body at all.
      )`
}

/**
 * `AND` clauses requiring every term in `messageBody` — an empty fragment for no
 * terms. Terms already split and bounded, not yet escaped.
 *
 * One `ILIKE` per term with a trigram, the rest in one `ILIKE ALL`, so
 * `message_body_trgm` can serve the search (#202) — `textMatchesAll` in
 * `search-terms.ts` holds the rule and why, shared with Telegram's search.
 */
function bodyMatchesAll(sql: Sql, terms: readonly string[]) {
  return textMatchesAll(sql, messageBody(sql), terms)
}

/**
 * Which row of a duplicate set to keep — as a select-list expression, aliased
 * `named`, because `DISTINCT ON` will not sort on anything the select list does
 * not carry. The same reason `m.id` is selected as `"rowId"`: it is the final
 * tiebreaker and nothing reads it.
 *
 * The copies differ in `pushName`, and only some of them carry a name: a history
 * import can store the sender's own device-locale word for themselves, a bare LID,
 * or a LID JID. Prefer a value that is none of those, so the row that survives is
 * the one with something worth reading — and prefer it *deterministically*, since
 * this decides what an identical second call returns.
 *
 * A last resort, not the mechanism: `authorName` still resolves the sender through
 * the directory first, and refuses a numeric "name" outright.
 */
function bestNamed(sql: Sql) {
  return sql`(m."pushName" IS NOT NULL AND m."pushName" !~ '^[+0-9]' AND m."pushName" NOT LIKE '%@%')`
}

/**
 * The sender's identity as stored, preferring the group participant.
 *
 * Baileys writes `participant` for a group message on both the live and the
 * history path, and `participantAlt` — the same person's other addressing form —
 * only on the live one. Either resolves, because the directory is keyed on the
 * local part. For a 1:1 chat there is no participant and the chat's own JID *is*
 * the sender, which is why `remoteJid` is the fallback rather than nothing.
 */
export function senderOf(row: { key: MessageKey | null, pushName: string | null }): { identity?: string, pushName?: string } {
  return {
    identity: row.key?.participant ?? row.key?.participantAlt ?? row.key?.remoteJid,
    pushName: row.pushName ?? undefined,
  }
}

/**
 * The parts of Baileys' message key this app reads.
 *
 * `participantAlt` and `remoteJidAlt` exist only on rows written by live traffic:
 * history sync hands over the bare protobuf key, which carries exactly
 * `remoteJid`, `fromMe`, `id` and `participant`. So the same conversation yields
 * richer keys for recent messages than for imported ones, and nothing may require
 * the alternate forms to be there.
 */
export interface MessageKey {
  id?: string
  fromMe?: boolean
  remoteJid?: string
  remoteJidAlt?: string
  /** The sender, in a group. Absent in a 1:1 chat. */
  participant?: string
  participantAlt?: string
}

interface MessagePageRow extends MessageRecord {
  /** `COUNT(*) OVER ()`. A bigint, so it arrives as a string. */
  total: string | number
}

interface MessageRow {
  key: MessageKey | null
  pushName: string | null
  messageType: string | null
  /** Unix seconds, not milliseconds — the column is an Int. */
  messageTimestamp: number | null
  body: string
  /**
   * `contextInfo.mentionedJid`, or null where the message mentions nobody.
   *
   * Taken from the `contextInfo` **column** rather than from `message`, because
   * 2.3.7 rewrites `extendedTextMessage` into `conversation` and deletes it on
   * the way in — so the copy nested under `message` is not there to be read. It
   * is a column of `"Message"`, which the read-only search role already selects,
   * so this needs no grant change.
   */
  mentioned: string[] | null
  /** `protocolMessage.key.id`, or null where the row is not an edit. */
  editOf: string | null
}

/**
 * A range bound, parsed once and refused loudly.
 *
 * The refusal matters more than the parse: an unreadable date silently floored
 * into a timestamp matches nothing, so it would come back as "no messages" —
 * indistinguishable from an empty conversation, which is the answer this whole
 * module exists not to give by accident. Shared with `read-messages`, which
 * needs the same bound as an ISO string to echo back as `window`, so the query
 * and the envelope cannot disagree about what a date is.
 */
export function parseDateBound(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw createError({
      statusCode: 400,
      message: `\`${field}\` is not a date I can read: ${value}. Use a format like 2024-03-01 or 2024-03-01T12:00:00Z.`,
    })
  }

  return new Date(parsed)
}

function toUnixSeconds(value: string | undefined, field: string): number | undefined {
  const parsed = parseDateBound(value, field)
  return parsed && Math.floor(parsed.getTime() / 1000)
}
