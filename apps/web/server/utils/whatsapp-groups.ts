import { setTimeout as delay } from 'node:timers/promises'
import type { AppInstance } from './app-db'
import type { EvolutionClient } from './evolution'
import { canReadMessages, readGroupChatNames } from './evolution-db'
import { rememberBounded } from './lookup-cache'

/**
 * WhatsApp group subjects and sizes — the only file that decides where they
 * come from, and the only reader and writer of `app.whatsapp_groups` and
 * `app.whatsapp_group_scans`.
 *
 * **WhatsApp is asked about one group at a time, slowly, or not at all (#175).**
 * Names used to come from Evolution's `fetchAllGroups`, and one call of it costs
 * about two WhatsApp queries per group: Baileys' `groupFetchAllParticipating()`
 * emits `groups.update` for every group, Evolution 2.3.7 answers each with a
 * `groupMetadata` query — all in the same second — and then fetches every
 * group's picture. Every six hours was still a burst of `rate-overlimit` (429)
 * on a 212-group account, and repeated rate-limit hits are the traffic that gets
 * a number restricted. We cannot pace that fan-out from outside, so it is gone.
 * In its place, three sources, best first:
 *
 *   1. **A live lookup we stored** — a row in `app.whatsapp_groups` whose
 *      `fetched_at` is under `GROUP_MAX_AGE_MS` old. Subject and size, as
 *      WhatsApp gave them then.
 *   2. **Evolution's `"Chat".name`** (`readGroupChatNames`), zero WhatsApp
 *      queries. Verified against 2.3.7's source: it is written once, when the
 *      chat row is inserted — from the history sync's `chats` at pairing, or
 *      from `chats.upsert` for a chat the account had no row for — and **never
 *      updated**: the `chats.update` Baileys emits on a rename carries the new
 *      name, and Evolution's handler is an `updateMany` that puts that name in
 *      its `WHERE` and writes nothing else. So it is the subject at pairing (or
 *      at the chat's first arrival), and a group renamed since keeps the old
 *      one here. Lower than (1) for exactly that reason. It carries no size.
 *   3. Nothing — `chats.ts` falls back to the contact name, then the bare id.
 *
 * **Lookups keep (1) fresh and fill what (2) cannot.** Evolution's single-group
 * `GET /group/findGroupInfos` is one `groupMetadata` plus one picture fetch, with
 * no cache in front of it (2.3.7's `findGroup`). A run asks about at most
 * `GROUP_LOOKUPS_PER_RUN` groups, `GROUP_LOOKUP_DELAY_MS` apart and never two at
 * once, at most once per `GROUP_LOOKUP_INTERVAL_MS` per account across every
 * replica (`claimGroupLookups`). What a run picks (`dueLookups`):
 *
 *   - groups with no name from (1) or (2) — joined after pairing, or with no
 *     `"Chat"` row at all — each retried at most every `GROUP_UNNAMED_RETRY_MS`;
 *   - then every other group whose last lookup is older than
 *     `GROUP_REFRESH_AGE_MS`, which is what catches renames and keeps
 *     `participantCount` roughly right — groups a lookup has answered before
 *     first, oldest lookup first, and only then named groups no lookup ever
 *     answered. Those are mostly groups the account has left (#178):
 *     `"Chat"` keeps a named row for every group the account was ever in, and
 *     the groups it is still in were answered by the old full scans.
 *
 * Groups the account is no longer in are not looked up for
 * `GROUP_GONE_RETRY_MS` (`gone_at`), once WhatsApp has said so.
 *
 * At the rates below an account costs WhatsApp at most a few dozen queries an
 * hour, spaced out, and a few hundred groups refresh over a working day each
 * week.
 *
 * **Why a lookup failed decides who pays for it** (`classifyLookupFailure`).
 * Evolution 2.3.7's `findGroup` catches every `groupMetadata` error alike and
 * answers 404 `{ response: { message: ['Error fetching group', String(error)] } }`,
 * so the second entry is the only thing that tells them apart: Baileys turns
 * WhatsApp's `<error text=…>` into `Error: <text>`, and its own socket failures
 * read `Error: Connection Closed` / `Error: Timed Out`.
 *
 *   - `forbidden`, `item-not-found`, `not-authorized` — the account is not in
 *     that group (left, removed, group deleted). WhatsApp answered, so the
 *     account is fine: the **group** is marked gone, and the run counts as one
 *     that got an answer. Logged at info, it is expected.
 *   - `rate-overlimit` — WhatsApp is throttling the number. The run stops at
 *     once, sends nothing more, and backs the account off even if earlier
 *     lookups answered.
 *   - anything else (dead socket, timeout, no body, a text never seen) — the
 *     account may not be able to answer; a run where nothing answered backs
 *     off, as before. A dead socket (`Connection Closed`) is also recorded as
 *     evidence for `stalled` (socket-evidence.ts, #205), and any answer from
 *     WhatsApp clears that evidence. Unknown text fails safe on this side, and its text is
 *     logged (it is WhatsApp's error condition, never personal data) so a
 *     new one can be classified.
 *
 * The back-off: every replica waits it out, it doubles with each such run in a
 * row (1 h, 2 h, 4 h … a day; `groupLookupBackoffMs`) and resets on the next
 * run that got an answer.
 *
 * Staleness, stated once and relied on by `chats.ts`:
 *
 *   - a renamed group shows its old subject until its next lookup — up to
 *     `GROUP_REFRESH_AGE_MS`, longer while the account is disconnected;
 *   - a group the account left keeps whatever name it had; its lookups are
 *     refused, so after `GROUP_MAX_AGE_MS` only `"Chat".name` names it;
 *   - logging out clears nothing — a subject belongs to the group, not to the
 *     account.
 *
 * Which groups exist, for a run: every group `"Chat"` row of the account, every
 * stored row, and the groups callers recently asked to name and could not
 * (`noteUnnamed`, in memory, per process). The last only matters for a group
 * with no `"Chat"` row, or a connection with no message database, where it is
 * the only way to learn of the group at all.
 *
 * Naming is best-effort, so nothing here throws into a request: reads fall back
 * to less, a failed claim answers "don't look up", a failed write is logged.
 */

/** How long a process serves the merged names before reading the sources again. */
const GROUP_TTL_MS = 5 * 60_000
/** Shortest gap between two lookup runs for one account, across replicas. */
const GROUP_LOOKUP_INTERVAL_MS = 15 * 60_000
/** Most groups one run asks WhatsApp about. */
const GROUP_LOOKUPS_PER_RUN = 4
/** Pause between two lookups in one run. */
const GROUP_LOOKUP_DELAY_MS = 5_000
/** One `findGroupInfos`: a `groupMetadata` and a picture. */
const GROUP_LOOKUP_TIMEOUT_MS = 30_000
/** Longer than a whole run, so a run still going is never claimed twice. */
const GROUP_LOOKUP_LEASE_MS = GROUP_LOOKUPS_PER_RUN * (GROUP_LOOKUP_TIMEOUT_MS + GROUP_LOOKUP_DELAY_MS) + 60_000
/** A group with a name is looked up again after this long — renames, sizes. */
const GROUP_REFRESH_AGE_MS = 7 * 24 * 60 * 60_000
/** A group with no name at all is retried after this long. */
const GROUP_UNNAMED_RETRY_MS = 24 * 60 * 60_000
/** Back-off after the first run in a row where every lookup failed; doubles. */
const GROUP_LOOKUP_FAILURE_BACKOFF_MS = 60 * 60_000
/** The longest back-off, however many failed runs. */
const GROUP_LOOKUP_MAX_FAILURE_BACKOFF_MS = 24 * 60 * 60_000
/** Failed runs past this many no longer lengthen the back-off; keeps the arithmetic finite. */
const GROUP_LOOKUP_FAILURE_EXPONENT_CAP = 10
/** A stored lookup older than this no longer names anything. */
const GROUP_MAX_AGE_MS = 30 * 24 * 60 * 60_000
/** A group WhatsApp said the account is not in is asked about again after this long — in case it rejoined. */
const GROUP_GONE_RETRY_MS = 30 * 24 * 60 * 60_000
/** Groups remembered per account as asked for and unnamed (`noteUnnamed`). */
const MAX_NOTED_UNNAMED = 500
/** What Evolution's `groupJidSchema` accepts; anything else is never looked up. */
const GROUP_JID = /^[\d-]+@g\.us$/

export interface GroupInfo {
  subject?: string
  size?: number
}

/**
 * How long every replica waits after `failures` failed runs in a row: 1 h after
 * the first, then 2 h, 4 h … up to `GROUP_LOOKUP_MAX_FAILURE_BACKOFF_MS`.
 * `claimGroupLookups` applies the same rule in SQL; this copy is for logging.
 */
function groupLookupBackoffMs(failures: number): number {
  const doublings = Math.min(Math.max(failures - 1, 0), GROUP_LOOKUP_FAILURE_EXPONENT_CAP)
  return Math.min(GROUP_LOOKUP_FAILURE_BACKOFF_MS * 2 ** doublings, GROUP_LOOKUP_MAX_FAILURE_BACKOFF_MS)
}

// ── the cache callers read ──────────────────────────────────────────────────

/** No groups known. Shared — also chats.ts's answer when it asks about none — so keep it immutable. */
export const emptyGroups: Map<string, GroupInfo> = new Map()

/**
 * Per process, refreshed in the background (`staleWhileRevalidate`). A cold
 * entry awaits `groupSources` — one app-database read and one indexed read of
 * Evolution's `"Chat"`, never WhatsApp — so the first listing after a deploy,
 * on another replica or for a disconnected account is still named. The refresh
 * re-reads both and, when lookups are due and this process wins the lease, runs
 * them before settling.
 */
const groupCache = staleWhileRevalidate<Map<string, GroupInfo>>({
  ttlMs: GROUP_TTL_MS,
  retryTtlMs: GROUP_TTL_MS,
  empty: emptyGroups,
})

/**
 * Subjects and sizes of the account's groups, keyed by group JID — whatever the
 * cache holds now. Never waits on WhatsApp.
 *
 * `wanted` are the group JIDs the caller is about to label. Those that come back
 * without a subject are remembered (`noteUnnamed`), so a group Evolution has no
 * `"Chat"` row for still gets looked up.
 */
export async function groupNamesFor(
  instance: AppInstance,
  evolution: EvolutionClient,
  wanted: readonly string[],
): Promise<Map<string, GroupInfo>> {
  const groups = await groupCache(
    instance.id,
    () => refreshGroups(instance, evolution),
    async () => (await groupSources(instance))?.merged,
  )
  noteUnnamed(instance.id, wanted.filter(jid => !groups.get(jid)?.subject))
  return groups
}

/** Per account, the unnamed groups callers asked about, oldest ask first. */
const unnamedByAccount = new Map<string, Map<string, true>>()
const MAX_NOTED_ACCOUNTS = 1000

function noteUnnamed(instanceId: string, jids: readonly string[]): void {
  const usable = jids.filter(jid => GROUP_JID.test(jid))
  if (!usable.length) return
  const noted = unnamedByAccount.get(instanceId) ?? new Map<string, true>()
  rememberBounded(unnamedByAccount, instanceId, noted, MAX_NOTED_ACCOUNTS)
  for (const jid of usable) rememberBounded(noted, jid, true, MAX_NOTED_UNNAMED)
}

// ── sources ─────────────────────────────────────────────────────────────────

interface StoredGroup extends GroupInfo {
  /** The last successful lookup. Absent when every lookup of it failed. */
  fetchedAt?: string
  /** The last lookup, successful or not. */
  checkedAt: string
  /** When WhatsApp last said the account is not in this group; cleared by an answer. */
  goneAt?: string
}

interface GroupSources {
  merged: Map<string, GroupInfo>
  stored: Map<string, StoredGroup>
  /** Group JIDs Evolution has a `"Chat"` row for, named or not. */
  chatJids: string[]
}

/**
 * Both sources, read and merged by the precedence in the header. `undefined`
 * when the app database cannot be read — the caller keeps what it had.
 *
 * `"Chat"` failing is not fatal: a missing grant (42501) is permanent until an
 * operator acts, so it is logged (once per `DENIED_LOG_QUIET_MS`) and naming
 * carries on from stored lookups alone; any other failure (an outage, the
 * account's busy slot) also carries on without it, since the stored rows are
 * still right. A connection with no message database never reads it.
 */
async function groupSources(instance: AppInstance): Promise<GroupSources | undefined> {
  const [stored, chatNames] = await Promise.all([
    readStoredGroups(instance.id),
    readChatNames(instance),
  ])
  if (!stored) return undefined

  const fresh = Date.now() - GROUP_MAX_AGE_MS
  const merged = new Map<string, GroupInfo>()

  for (const [jid, name] of chatNames) {
    if (name) merged.set(jid, { subject: name })
  }
  for (const [jid, row] of stored) {
    if (!row.fetchedAt || Date.parse(row.fetchedAt) <= fresh) continue
    merged.set(jid, {
      subject: row.subject ?? merged.get(jid)?.subject,
      size: row.size,
    })
  }

  return { merged, stored, chatJids: [...chatNames.keys()] }
}

const DENIED_LOG_QUIET_MS = 5 * 60_000
let deniedLoggedAt = 0

async function readChatNames(instance: AppInstance): Promise<Map<string, string | undefined>> {
  if (!canReadMessages(instance)) return new Map()
  try {
    return await readGroupChatNames(instance)
  }
  catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code
    if (code === '42501') {
      if (Date.now() - deniedLoggedAt > DENIED_LOG_QUIET_MS) {
        deniedLoggedAt = Date.now()
        console.warn('[groups] the Evolution database role cannot read "Chat"."remoteJid"/"name", so group names '
          + 'come only from slow per-group lookups. Add the "Chat" grant in docs/whatsapp.md "Reading and searching messages".')
      }
    }
    else if (httpStatusOf(error) !== 429) {
      console.warn(`[groups] could not read group names from Evolution's database for connection ${instance.id}:`,
        error instanceof Error ? error.message : error)
    }
    return new Map()
  }
}

/**
 * Every stored row of the account — including ones whose lookups only ever
 * failed, since `checked_at` is what paces the next try. `undefined` when the
 * read failed.
 */
async function readStoredGroups(instanceId: string): Promise<Map<string, StoredGroup> | undefined> {
  try {
    const sql = await appDb()
    const rows = await sql<Array<{ jid: string, subject?: string, size?: number, fetched_at?: string, checked_at: string, gone_at?: string }>>`
      SELECT jid, subject, size, fetched_at, checked_at, gone_at
      FROM app.whatsapp_groups
      WHERE instance_id = ${instanceId}`

    return new Map(rows.map(row => [row.jid, {
      subject: row.subject,
      size: row.size,
      fetchedAt: row.fetched_at,
      checkedAt: row.checked_at,
      goneAt: row.gone_at,
    }]))
  }
  catch (error) {
    console.warn(`[groups] could not read stored groups for connection ${instanceId}:`, error instanceof Error ? error.message : error)
    return undefined
  }
}

// ── lookups ─────────────────────────────────────────────────────────────────

/**
 * The background refresh: read the sources, and when lookups are due and this
 * process wins the account's lease, run them and fold the answers in.
 */
async function refreshGroups(instance: AppInstance, evolution: EvolutionClient): Promise<Map<string, GroupInfo> | undefined> {
  const sources = await groupSources(instance)
  if (!sources) return undefined

  const noted = unnamedByAccount.get(instance.id)
  const due = dueLookups(sources, noted ?? new Map())
  if (!due.length || !await claimGroupLookups(instance.id)) return sources.merged

  const merged = new Map(sources.merged)
  let succeeded = 0
  let gone = 0
  let tried = 0
  let lastFailure: LookupFailure | undefined

  for (const [index, jid] of due.entries()) {
    if (index > 0) await delay(GROUP_LOOKUP_DELAY_MS)
    tried = index + 1
    let found: GroupInfo | undefined
    let failure: LookupFailure | undefined
    try {
      found = await lookUpGroup(instance, evolution, jid)
      if (!found) failure = { kind: 'other', reason: 'an answer about another group' }
    }
    catch (error) {
      failure = classifyLookupFailure(error)
    }

    // WhatsApp answered over the socket — about this group, or to say the
    // account is not in it, or that it is counting. Evidence of a dead socket
    // is out of date; a dead one is evidence (#205, socket-evidence.ts).
    if (found || failure?.kind === 'gone' || failure?.kind === 'throttled') noteSocketAlive(instance)
    else if (failure?.deadSocket) noteSocketDead(instance, 'group lookup')

    if (found) {
      await storeLookup(instance.id, jid, found)
      succeeded++
      noted?.delete(jid)
      merged.set(jid, { subject: found.subject ?? merged.get(jid)?.subject, size: found.size })
      continue
    }

    if (failure?.kind === 'gone') {
      await storeGone(instance.id, jid)
      gone++
      noted?.delete(jid)
      continue
    }

    await storeLookup(instance.id, jid, undefined)
    lastFailure = failure
    // Every further query now only adds to what WhatsApp is counting.
    if (failure?.kind === 'throttled') break
  }
  const throttled = lastFailure?.kind === 'throttled'

  if (gone > 0) {
    console.info(`[groups] ${gone} of ${tried} group lookups for connection ${instance.id} named groups the account is no longer in; `
      + `those are not looked up again for ${GROUP_GONE_RETRY_MS / 86_400_000} days`)
  }

  if (!throttled && succeeded + gone > 0) {
    await recordGroupLookupRun(instance.id)
  }
  else {
    const backoffMs = await recordGroupLookupFailure(instance.id)
    const next = backoffMs === undefined ? 'retried when the lease lapses' : `next run in ${backoffMs / 60_000} min`
    const reason = lastFailure?.reason ?? 'unexpected response'
    if (throttled) {
      console.warn(`[groups] WhatsApp is rate-limiting group lookups for connection ${instance.id}; run stopped after ${tried} of ${due.length}, ${next}:`, reason)
    }
    else {
      console.warn(`[groups] every group lookup failed for connection ${instance.id} (${tried} tried); ${next}:`, reason)
    }
  }

  return merged
}

/** Why one lookup failed, as far as it decides who pays for it — see the header. */
interface LookupFailure {
  kind: 'gone' | 'throttled' | 'other'
  /** For the log: WhatsApp's error text when Evolution relayed it, else the request error. */
  reason: string
  /** Evolution relayed Baileys' dead-socket error (`Connection Closed`) — see `namesDeadSocket`. */
  deadSocket?: boolean
}

/** WhatsApp's answers meaning "the account is not in this group" — standard XMPP error conditions. */
const NOT_A_MEMBER = /^(?:Error: )?(?:forbidden|item-not-found|not-authorized)$/i
const RATE_LIMITED = /rate-overlimit/i

/**
 * Sort a failed `findGroupInfos` by what failed. Only a 404 carrying one of
 * the exact texts in `NOT_A_MEMBER` is a group the account is not in — anything
 * looser would let an unrecognised failure skip the account's back-off.
 */
function classifyLookupFailure(error: unknown): LookupFailure {
  const texts = evolutionErrorEntries(error).filter((e): e is string => typeof e === 'string').map(e => e.trim())
  // Entry 0 is Evolution's own 'Error fetching group'; the cause follows it.
  const cause = texts.length > 1 ? texts.slice(1).join('; ') : undefined
  const reason = (cause ?? (error instanceof Error ? error.message : String(error ?? 'no answer'))).slice(0, 200)

  if (cause && RATE_LIMITED.test(cause)) return { kind: 'throttled', reason }
  if (httpStatusOf(error) === 404 && texts.slice(1).some(text => NOT_A_MEMBER.test(text))) return { kind: 'gone', reason }
  return { kind: 'other', reason, ...(namesDeadSocket(texts.slice(1)) && { deadSocket: true }) }
}

/**
 * Which groups this run asks about, best first, at most `GROUP_LOOKUPS_PER_RUN`.
 *
 * Unnamed groups first — those a caller asked to label before the rest — then
 * named ones due a refresh: oldest lookup first among groups a lookup has
 * answered, then groups no lookup ever answered or one said the account left
 * (mostly dead, #178). Groups seen gone within `GROUP_GONE_RETRY_MS` are not
 * candidates at all, even when a caller asks for them.
 */
function dueLookups(sources: GroupSources, noted: ReadonlyMap<string, true>): string[] {
  const now = Date.now()
  const known = new Set([...sources.chatJids, ...sources.stored.keys(), ...noted.keys()])

  const candidates: Array<{ jid: string, rank: number, checkedAt: number }> = []
  for (const jid of known) {
    if (!GROUP_JID.test(jid)) continue
    const stored = sources.stored.get(jid)
    if (stored?.goneAt && now - Date.parse(stored.goneAt) < GROUP_GONE_RETRY_MS) continue
    const checkedAt = stored?.checkedAt ? Date.parse(stored.checkedAt) : Number.NEGATIVE_INFINITY
    const named = Boolean(sources.merged.get(jid)?.subject)
    const age = now - checkedAt
    if (named ? age < GROUP_REFRESH_AGE_MS : age < GROUP_UNNAMED_RETRY_MS) continue
    const answeredBefore = Boolean(stored?.fetchedAt) && !stored?.goneAt
    const rank = !named ? (noted.has(jid) ? 0 : 1) : answeredBefore ? 2 : 3
    candidates.push({ jid, rank, checkedAt })
  }

  return candidates
    .sort((a, b) => a.rank - b.rank || a.checkedAt - b.checkedAt)
    .slice(0, GROUP_LOOKUPS_PER_RUN)
    .map(candidate => candidate.jid)
}

/** What `GET /group/findGroupInfos` answers with — only the fields read here. */
interface EvolutionGroupInfo {
  id?: string
  subject?: string
  size?: number
}

/** One group, from WhatsApp, through Evolution. `undefined` for an answer that is not about this group. */
async function lookUpGroup(instance: AppInstance, evolution: EvolutionClient, jid: string): Promise<GroupInfo | undefined> {
  const row = await evolution<EvolutionGroupInfo>(
    `/group/findGroupInfos/${encodeURIComponent(instance.name)}?groupJid=${encodeURIComponent(jid)}`,
    { timeout: GROUP_LOOKUP_TIMEOUT_MS },
  )
  if (row?.id !== jid) return undefined
  return {
    subject: row.subject?.trim() || undefined,
    size: typeof row.size === 'number' && Number.isInteger(row.size) && row.size >= 0 ? row.size : undefined,
  }
}

// ── storage ─────────────────────────────────────────────────────────────────

/**
 * Record one lookup. A success writes subject, size and both dates; a failure
 * moves only `checked_at`, so the last good answer stays and the group is not
 * asked about again until its retry is due.
 *
 * A foreign-key violation means the connection was deleted mid-run; logged and
 * dropped like any other failed write.
 */
async function storeLookup(instanceId: string, jid: string, found: GroupInfo | undefined): Promise<void> {
  try {
    const sql = await appDb()
    if (found) {
      await sql`
        INSERT INTO app.whatsapp_groups (instance_id, jid, subject, size, fetched_at, checked_at)
        VALUES (${instanceId}, ${jid}, ${found.subject ?? null}, ${found.size ?? null}, now(), now())
        ON CONFLICT (instance_id, jid) DO UPDATE
          SET subject = EXCLUDED.subject, size = EXCLUDED.size,
              fetched_at = now(), checked_at = now(), gone_at = NULL`
    }
    else {
      await sql`
        INSERT INTO app.whatsapp_groups (instance_id, jid, checked_at)
        VALUES (${instanceId}, ${jid}, now())
        ON CONFLICT (instance_id, jid) DO UPDATE SET checked_at = now()`
    }
  }
  catch (error) {
    console.warn(`[groups] could not store a group lookup for connection ${instanceId}:`, error instanceof Error ? error.message : error)
  }
}

/**
 * Record that WhatsApp said the account is not in this group. Subject, size and
 * `fetched_at` stay — a left group keeps its last name until that ages out.
 */
async function storeGone(instanceId: string, jid: string): Promise<void> {
  try {
    const sql = await appDb()
    await sql`
      INSERT INTO app.whatsapp_groups (instance_id, jid, checked_at, gone_at)
      VALUES (${instanceId}, ${jid}, now(), now())
      ON CONFLICT (instance_id, jid) DO UPDATE SET checked_at = now(), gone_at = now()`
  }
  catch (error) {
    console.warn(`[groups] could not store a group lookup for connection ${instanceId}:`, error instanceof Error ? error.message : error)
  }
}

/**
 * Whether this process may run lookups for the account now — and if so, it
 * holds the lease until `recordGroupLookupRun` or `recordGroupLookupFailure`
 * releases it, or `GROUP_LOOKUP_LEASE_MS` passes.
 *
 * A conditional UPDATE, so of any number of replicas reading at once exactly one
 * wins, and no database connection is held across the run. A failure to ask
 * answers `false`: when we cannot coordinate, we do not query WhatsApp.
 *
 * `scanned_at` is the end of the last run that got any answer and `failed_at`
 * of the last that got none — the column names date from the whole-account
 * scan this replaced.
 */
async function claimGroupLookups(instanceId: string): Promise<boolean> {
  try {
    const sql = await appDb()
    await sql`INSERT INTO app.whatsapp_group_scans (instance_id) VALUES (${instanceId}) ON CONFLICT DO NOTHING`
    const claimed = await sql`
      UPDATE app.whatsapp_group_scans
      SET lease_until = now() + make_interval(secs => ${GROUP_LOOKUP_LEASE_MS / 1000})
      WHERE instance_id = ${instanceId}
        AND (lease_until IS NULL OR lease_until < now())
        AND (scanned_at IS NULL OR scanned_at < now() - make_interval(secs => ${GROUP_LOOKUP_INTERVAL_MS / 1000}))
        AND (
          failed_at IS NULL OR failures = 0
          OR failed_at < now() - make_interval(secs => LEAST(
            ${GROUP_LOOKUP_FAILURE_BACKOFF_MS / 1000}::float8
              * power(2, LEAST(GREATEST(failures - 1, 0), ${GROUP_LOOKUP_FAILURE_EXPONENT_CAP})),
            ${GROUP_LOOKUP_MAX_FAILURE_BACKOFF_MS / 1000}::float8)))
      RETURNING 1`
    return claimed.length > 0
  }
  catch (error) {
    console.warn(`[groups] could not claim group lookups for connection ${instanceId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * A run that got at least one answer — a group, or WhatsApp saying the account
 * is not in one: reset the failure count, release the lease.
 */
async function recordGroupLookupRun(instanceId: string): Promise<void> {
  try {
    const sql = await appDb()
    await sql`
      UPDATE app.whatsapp_group_scans
      SET scanned_at = now(), failures = 0, lease_until = NULL
      WHERE instance_id = ${instanceId}`
  }
  catch (error) {
    console.warn(`[groups] could not record a group lookup run for connection ${instanceId}:`, error instanceof Error ? error.message : error)
  }
}

/**
 * A run where nothing answered, or WhatsApp rate-limited it: one more failure in a row, and every replica
 * now waits out the back-off it sets. Releases the lease. Answers that back-off
 * for the log, or `undefined` when the write failed — the lease then runs out.
 */
async function recordGroupLookupFailure(instanceId: string): Promise<number | undefined> {
  try {
    const sql = await appDb()
    const rows = await sql<Array<{ failures: number }>>`
      UPDATE app.whatsapp_group_scans
      SET failed_at = now(), failures = failures + 1, lease_until = NULL
      WHERE instance_id = ${instanceId}
      RETURNING failures`
    return rows[0] ? groupLookupBackoffMs(rows[0].failures) : undefined
  }
  catch (error) {
    console.warn(`[groups] could not record a failed group lookup run for connection ${instanceId}:`, error instanceof Error ? error.message : error)
    return undefined
  }
}
