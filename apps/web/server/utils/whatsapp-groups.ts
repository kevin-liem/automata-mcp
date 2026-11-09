import type { AppInstance } from './app-db'
import type { EvolutionClient } from './evolution'
import { canReadMessages, readGroupChatNames } from './evolution-db'

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
 *     `GROUP_REFRESH_AGE_MS`, never-looked-up first, which is what catches
 *     renames and keeps `participantCount` roughly right.
 *
 * At the rates below an account costs WhatsApp at most a few dozen queries an
 * hour, spaced out, and a few hundred groups refresh over a working day each
 * week.
 *
 * A run in which every lookup failed is an account that cannot answer (no live
 * socket) far more often than a run of groups it left, so every replica then
 * waits out a back-off that doubles with each such run in a row (1 h, 2 h, 4 h …
 * a day; `groupLookupBackoffMs`) and resets on the next run that got anything.
 *
 * Staleness, stated once and relied on by `chats.ts`:
 *
 *   - a renamed group shows its old subject until its next lookup — up to
 *     `GROUP_REFRESH_AGE_MS`, longer while the account is disconnected;
 *   - a group the account left keeps whatever name it had; its lookups fail,
 *     so after `GROUP_MAX_AGE_MS` only `"Chat".name` names it;
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
export const GROUP_LOOKUP_INTERVAL_MS = 15 * 60_000
/** Most groups one run asks WhatsApp about. */
export const GROUP_LOOKUPS_PER_RUN = 4
/** Pause between two lookups in one run. */
export const GROUP_LOOKUP_DELAY_MS = 5_000
/** One `findGroupInfos`: a `groupMetadata` and a picture. */
const GROUP_LOOKUP_TIMEOUT_MS = 30_000
/** Longer than a whole run, so a run still going is never claimed twice. */
const GROUP_LOOKUP_LEASE_MS = GROUP_LOOKUPS_PER_RUN * (GROUP_LOOKUP_TIMEOUT_MS + GROUP_LOOKUP_DELAY_MS) + 60_000
/** A group with a name is looked up again after this long — renames, sizes. */
export const GROUP_REFRESH_AGE_MS = 7 * 24 * 60 * 60_000
/** A group with no name at all is retried after this long. */
export const GROUP_UNNAMED_RETRY_MS = 24 * 60 * 60_000
/** Back-off after the first run in a row where every lookup failed; doubles. */
export const GROUP_LOOKUP_FAILURE_BACKOFF_MS = 60 * 60_000
/** The longest back-off, however many failed runs. */
export const GROUP_LOOKUP_MAX_FAILURE_BACKOFF_MS = 24 * 60 * 60_000
/** Failed runs past this many no longer lengthen the back-off; keeps the arithmetic finite. */
const GROUP_LOOKUP_FAILURE_EXPONENT_CAP = 10
/** A stored lookup older than this no longer names anything. */
export const GROUP_MAX_AGE_MS = 30 * 24 * 60 * 60_000
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
export function groupLookupBackoffMs(failures: number): number {
  const doublings = Math.min(Math.max(failures - 1, 0), GROUP_LOOKUP_FAILURE_EXPONENT_CAP)
  return Math.min(GROUP_LOOKUP_FAILURE_BACKOFF_MS * 2 ** doublings, GROUP_LOOKUP_MAX_FAILURE_BACKOFF_MS)
}

// ── the cache callers read ──────────────────────────────────────────────────

const emptyGroups: Map<string, GroupInfo> = new Map()

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

const unnamedByAccount = new Map<string, Set<string>>()

function noteUnnamed(instanceId: string, jids: readonly string[]): void {
  const usable = jids.filter(jid => GROUP_JID.test(jid))
  if (!usable.length) return
  let noted = unnamedByAccount.get(instanceId)
  if (!noted) unnamedByAccount.set(instanceId, noted = new Set())
  for (const jid of usable) {
    // Re-inserted at the end, so the oldest ask is the first to go.
    noted.delete(jid)
    noted.add(jid)
  }
  for (const jid of noted) {
    if (noted.size <= MAX_NOTED_UNNAMED) break
    noted.delete(jid)
  }
}

// ── sources ─────────────────────────────────────────────────────────────────

interface StoredGroup extends GroupInfo {
  /** The last successful lookup. Absent when every lookup of it failed. */
  fetchedAt?: string
  /** The last lookup, successful or not. */
  checkedAt: string
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
    else if ((error as { statusCode?: number })?.statusCode !== 429) {
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
    const rows = await sql<Array<{ jid: string, subject?: string, size?: number, fetched_at?: string, checked_at: string }>>`
      SELECT jid, subject, size, fetched_at, checked_at
      FROM app.whatsapp_groups
      WHERE instance_id = ${instanceId}`

    return new Map(rows.map(row => [row.jid, {
      subject: row.subject,
      size: row.size,
      fetchedAt: row.fetched_at,
      checkedAt: row.checked_at,
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

  const due = dueLookups(sources, unnamedByAccount.get(instance.id) ?? new Set())
  if (!due.length || !await claimGroupLookups(instance.id)) return sources.merged

  const merged = new Map(sources.merged)
  let succeeded = 0
  let lastFailure: unknown

  for (const [index, jid] of due.entries()) {
    if (index > 0) await delay(GROUP_LOOKUP_DELAY_MS)
    const found = await lookUpGroup(instance, evolution, jid).catch((error: unknown) => {
      lastFailure = error
      return undefined
    })
    await storeLookup(instance.id, jid, found)
    if (!found) continue
    succeeded++
    unnamedByAccount.get(instance.id)?.delete(jid)
    merged.set(jid, { subject: found.subject ?? merged.get(jid)?.subject, size: found.size })
  }

  if (succeeded > 0) {
    await recordGroupLookupRun(instance.id)
  }
  else {
    const backoffMs = await recordGroupLookupFailure(instance.id)
    const next = backoffMs === undefined ? 'retried when the lease lapses' : `next run in ${backoffMs / 60_000} min`
    const reason = lastFailure instanceof Error ? lastFailure.message : lastFailure ?? 'unexpected response'
    console.warn(`[groups] every group lookup failed for connection ${instance.id} (${due.length} tried); ${next}:`, reason)
  }

  return merged
}

/**
 * Which groups this run asks about, best first, at most `GROUP_LOOKUPS_PER_RUN`.
 *
 * Unnamed groups first — those a caller asked to label before the rest — then
 * named ones due a refresh, never-looked-up first and then oldest lookup first.
 */
function dueLookups(sources: GroupSources, noted: ReadonlySet<string>): string[] {
  const now = Date.now()
  const known = new Set([...sources.chatJids, ...sources.stored.keys(), ...noted])

  const candidates: Array<{ jid: string, rank: number, checkedAt: number }> = []
  for (const jid of known) {
    if (!GROUP_JID.test(jid)) continue
    const checked = sources.stored.get(jid)?.checkedAt
    const checkedAt = checked ? Date.parse(checked) : Number.NEGATIVE_INFINITY
    const named = Boolean(sources.merged.get(jid)?.subject)
    const age = now - checkedAt
    if (named ? age < GROUP_REFRESH_AGE_MS : age < GROUP_UNNAMED_RETRY_MS) continue
    candidates.push({ jid, rank: named ? 2 : noted.has(jid) ? 0 : 1, checkedAt })
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
              fetched_at = now(), checked_at = now()`
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

/** A run that got at least one answer: reset the failure count, release the lease. */
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
 * A run where every lookup failed: one more failure in a row, and every replica
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
