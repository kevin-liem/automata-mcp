import type { ImapFlow, FetchMessageObject, ListResponse, MessageAddressObject } from 'imapflow'
import type { AppInstance } from './app-db'
import type { ImapTarget } from './imap-client'

/**
 * Copies a mailbox's **headers** into `app.mail_*`, so listing, counting and
 * searching by sender, subject and date are SQL. Bodies and attachments are
 * never synced — they are fetched live when a tool asks (imap-client.ts) — so a
 * row is about a kilobyte whatever the message weighs.
 *
 * Runs in-process from the `imap:sync` task every two minutes, and on demand
 * from the dashboard's "Sync now". Rules easy to undo:
 *
 * - **A lease, claimed by conditional UPDATE, decides who syncs.** Every
 *   replica runs the task; `lease_until < now()` lets exactly one of them in
 *   per mailbox per run, without holding a database connection for the
 *   minutes a backfill takes. The lease outlives `RUN_BUDGET_MS` by a margin,
 *   so a slow run is not joined by a second one halfway through.
 * - **UIDVALIDITY is checked before every folder.** A changed value means the
 *   server renumbered the folder and every stored UID may name a different
 *   message now; the folder's rows are deleted and it starts again. Keeping
 *   them would attach one message's headers to another's body.
 * - **Identity is checked before every run.** New credentials naming another
 *   mailbox delete everything synced from the old one.
 * - **An authentication failure stops the sync** (`auth_failed`) until the
 *   credentials change. Retrying a refused password every two minutes is how
 *   providers lock accounts.
 * - **Every write is an idempotent upsert**, so a run that dies halfway leaves
 *   nothing a later run cannot redo.
 * - **Gmail's All Mail, Junk and Trash are listed but not synced.** All Mail
 *   holds every message again under a second UID; Junk and Trash are not what
 *   anyone means by "my mail". They still appear in `list-mail-folders` with
 *   `synced: false`, so their existence is not hidden.
 */

const LEASE_MS = 10 * 60_000
/** Work per mailbox per run. Whatever is left is the next run's. */
const RUN_BUDGET_MS = 4 * 60_000
/**
 * Where a run is cut off, not wound down. `RUN_BUDGET_MS` is only checked
 * between folders and chunks, and imapflow's `socketTimeout` is an idle timer,
 * so a server that trickles a reply never trips either. Past this the socket is
 * closed under the run. Inside `LEASE_MS`, so the lease really does outlive it.
 */
const RUN_HARD_LIMIT_MS = RUN_BUDGET_MS + 2 * 60_000
/** Headers fetched per folder per run, newest first, while backfilling. */
const BACKFILL_CHUNK = 500
/** New mail fetched per folder per run. A mailbox offline for a month catches up over several runs. */
const NEW_CHUNK = 2000
/** Without CONDSTORE, how many of the newest messages have their flags re-read each run. */
const FLAG_REFRESH = 500
/** Mailboxes synced at once by one process. */
const CONCURRENCY = 4
/** A full UID listing to find expunged messages, every Nth run — and always when counts disagree. */
const EXPUNGE_EVERY = 5

const SKIPPED_SPECIAL_USE = new Set(['\\All', '\\Junk', '\\Trash'])

export interface MailSyncLimits {
  days: number
  max: number
}

export function mailSyncLimits(): MailSyncLimits {
  const config = useRuntimeConfig()
  const days = Number(config.imapBackfillDays)
  const max = Number(config.imapBackfillMax)
  return {
    days: Number.isFinite(days) && days > 0 ? days : 365,
    max: Number.isFinite(max) && max > 0 ? max : 50_000,
  }
}

/** The scheduled task: every IMAP connection, a few at a time. */
export async function runImapSync(): Promise<{ claimed: number, failed: number }> {
  const sql = await appDb()
  const instances = await sql<AppInstance[]>`SELECT * FROM app.instances WHERE kind = 'imap'`

  let claimed = 0
  let failed = 0
  // Each mailbox bounded on top of the socket being closed at
  // `RUN_HARD_LIMIT_MS`: a mailbox server is user-chosen, and a run that never
  // settles would hold this task, and through Nitro's `runTask` every later
  // one, for every other mailbox (GHSA-g2cf-mx92-xc53).
  const tally = (outcome: SyncOutcome) => {
    if (outcome === 'synced' || outcome === 'failed') claimed++
    if (outcome === 'failed') failed++
  }
  await forEachBounded(instances, {
    concurrency: CONCURRENCY,
    deadlineMs: RUN_HARD_LIMIT_MS + 60_000,
    what: instance => `syncing mailbox ${instance.id}`,
    onError: (instance, error) => {
      tally('failed')
      console.error(`[imap-sync] sync of ${instance.id} did not finish`, error)
    },
  }, async instance => tally(await syncMailbox(instance)))
  return { claimed, failed }
}

/**
 * Start a sync now, without waiting for it. Answers whether one was started —
 * `false` when another run holds the lease, which is already doing the work.
 */
export async function requestImapSync(instance: AppInstance): Promise<boolean> {
  const lease = await claimLease(instance, { ignoreAuthFailure: true })
  if (!lease) return false
  void runClaimed(instance, lease).catch(cause => console.error(`[imap-sync] sync of ${instance.id} failed`, cause))
  return true
}

type SyncOutcome = 'synced' | 'failed' | 'busy' | 'skipped'

export async function syncMailbox(instance: AppInstance): Promise<SyncOutcome> {
  const lease = await claimLease(instance, { ignoreAuthFailure: false })
  if (!lease) return 'busy'
  return await runClaimed(instance, lease)
}

interface Lease {
  runs: number
  target: ImapTarget
}

async function claimLease(instance: AppInstance, options: { ignoreAuthFailure: boolean }): Promise<Lease | undefined> {
  const target = imapTargetOf(instance)
  if (!target) return undefined

  const sql = await appDb()
  await sql`INSERT INTO app.mail_sync_state (instance_id) VALUES (${instance.id}) ON CONFLICT DO NOTHING`
  const [row] = await sql<Array<{ runs: number }>>`
    UPDATE app.mail_sync_state
    SET lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval,
        last_attempt_at = now(),
        runs = runs + 1
    WHERE instance_id = ${instance.id}
      AND lease_until < now()
      ${options.ignoreAuthFailure ? sql`` : sql`AND NOT auth_failed`}
    RETURNING runs`
  return row ? { runs: row.runs, target } : undefined
}

async function runClaimed(instance: AppInstance, lease: Lease): Promise<SyncOutcome> {
  const sql = await appDb()
  const deadline = Date.now() + RUN_BUDGET_MS
  let client: ImapFlow | undefined
  let cutOff = false
  // Closing the socket rejects whatever command is waiting on it, so the run
  // unwinds through the ordinary failure path below. Before `openImap` has
  // returned there is no client here to close, so the abort reaches it there
  // (GHSA-rv5g-x6rm-cvh5).
  const abort = new AbortController()
  const watchdog = setTimeout(() => {
    cutOff = true
    abort.abort()
    client?.close()
  }, RUN_HARD_LIMIT_MS)
  try {
    await resetIfIdentityChanged(instance, lease.target)
    client = await openImap(lease.target, undefined, { signal: abort.signal })
    if (cutOff) throw new DeadlineExceededError(`syncing mailbox ${instance.id}`, RUN_HARD_LIMIT_MS)
    const folderFailed = await syncFolders(instance, client, lease, deadline)
    if (folderFailed) {
      // Not a success: last_success_at is what `syncedAt`, `staleSyncNote`
      // and the dashboard read as "listings are current up to here", and a
      // folder that failed was not brought up to date. The other folders'
      // progress is kept in their own rows.
      await sql`
        UPDATE app.mail_sync_state
        SET last_error_code = ${folderFailed}, last_error_at = now(), auth_failed = false, lease_until = now()
        WHERE instance_id = ${instance.id}`
      return 'failed'
    }
    await sql`
      UPDATE app.mail_sync_state
      SET last_success_at = now(), last_error_code = NULL, auth_failed = false, lease_until = now()
      WHERE instance_id = ${instance.id}`
    return 'synced'
  }
  catch (cause) {
    const described = (cause as { statusCode?: number })?.statusCode
      ? { code: 'host_refused', auth: false }
      : describeImapError(cause)
    // Logged with the cause: a handled failure is otherwise invisible, and the
    // stored code is all the dashboard shows.
    console.error(`[imap-sync] connection ${instance.id} failed (${described.code})`, cause)
    await sql`
      UPDATE app.mail_sync_state
      SET last_error_code = ${described.code}, last_error_at = now(),
          auth_failed = ${described.auth}, lease_until = now()
      WHERE instance_id = ${instance.id}`.catch(() => {})
    return 'failed'
  }
  finally {
    if (client) await closeImap(client)
    clearTimeout(watchdog)
  }
}

/**
 * Forget everything synced under a different mailbox. Also called by the
 * credential update, in its own transaction, so the dashboard never shows the
 * old mailbox's folders under the new one's name.
 */
export async function resetIfIdentityChanged(instance: Pick<AppInstance, 'id'>, target: Pick<ImapTarget, 'host' | 'user'>): Promise<void> {
  const identity = imapIdentity(target)
  const sql = await appDb()
  await sql.begin(async (tx) => {
    const [state] = await tx<Array<{ identity: string }>>`
      SELECT identity FROM app.mail_sync_state WHERE instance_id = ${instance.id} FOR UPDATE`
    if (state && state.identity === identity) return
    await tx`DELETE FROM app.mail_folders WHERE instance_id = ${instance.id}`
    await tx`
      INSERT INTO app.mail_sync_state (instance_id, identity) VALUES (${instance.id}, ${identity})
      ON CONFLICT (instance_id) DO UPDATE
      SET identity = EXCLUDED.identity, auth_failed = false, last_error_code = NULL,
          last_success_at = NULL`
  })
}

/** Answers the error code of the first folder that failed, or nothing when none did. */
async function syncFolders(instance: AppInstance, client: ImapFlow, lease: Lease, deadline: number): Promise<string | undefined> {
  const sql = await appDb()
  const listed = uniqueFolders(await client.list())

  const folders = listed.map(folder => ({
    path: folder.path,
    name: folder.name,
    delimiter: folder.delimiter || undefined,
    special_use: folder.specialUse,
    synced: isSyncable(folder),
  }))

  if (folders.length) {
    await sql`
      INSERT INTO app.mail_folders ${sql(folders.map(f => ({ instance_id: instance.id, ...f })))}
      ON CONFLICT (instance_id, path) DO UPDATE
      SET name = EXCLUDED.name, delimiter = EXCLUDED.delimiter,
          special_use = EXCLUDED.special_use, synced = EXCLUDED.synced`
  }
  // A folder the server no longer lists takes its rows with it (cascade).
  await sql`
    DELETE FROM app.mail_folders
    WHERE instance_id = ${instance.id} AND NOT (path = ANY(${folders.map(f => f.path)}::text[]))`
  // A folder that stopped being synced (newly marked Junk) keeps no rows.
  await sql`
    DELETE FROM app.mail_messages m USING app.mail_folders f
    WHERE f.instance_id = ${instance.id} AND m.instance_id = f.instance_id
      AND m.folder_path = f.path AND NOT f.synced`

  // INBOX first, then Sent, then the rest: when the budget runs out, the
  // folders people ask about are the ones that are current.
  const order = (f: { path: string, special_use?: string }) =>
    f.path.toUpperCase() === 'INBOX' ? 0 : f.special_use === '\\Sent' ? 1 : 2
  const toSync = folders.filter(f => f.synced).sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path))

  let failed: string | undefined
  for (const folder of toSync) {
    if (Date.now() > deadline) break
    try {
      await syncFolder(instance, client, folder.path, lease, deadline)
    }
    catch (cause) {
      // One unreadable folder must not stop the rest. A connection-level
      // failure will fail the next folder too and end the run there.
      if (!client.usable) throw cause
      const code = describeImapError(cause).code
      console.error(`[imap-sync] connection ${instance.id}: a folder failed (${code})`, cause)
      failed ??= code
    }
  }
  return failed
}

/**
 * One entry per path. Some servers (Lark Mail) list the same folder more than
 * once, and a batch upsert naming one key twice fails outright with 21000
 * (`ON CONFLICT DO UPDATE command cannot affect row a second time`) — the
 * whole sync, not one folder. Where copies disagree, a selectable one wins over
 * a `\Noselect` one, then one carrying a special-use flag.
 */
function uniqueFolders(listed: ListResponse[]): ListResponse[] {
  const rank = (f: ListResponse) =>
    (f.flags.has('\\Noselect') || f.flags.has('\\NonExistent') ? 0 : 2) + (f.specialUse ? 1 : 0)
  const byPath = new Map<string, ListResponse>()
  for (const folder of listed) {
    const seen = byPath.get(folder.path)
    if (!seen || rank(folder) > rank(seen)) byPath.set(folder.path, folder)
  }
  if (byPath.size < listed.length) {
    console.warn(`[imap-sync] the mail server listed ${listed.length - byPath.size} folder(s) more than once; kept one of each`)
  }
  return [...byPath.values()]
}

function isSyncable(folder: ListResponse): boolean {
  if (folder.flags.has('\\Noselect') || folder.flags.has('\\NonExistent')) return false
  return !(folder.specialUse && SKIPPED_SPECIAL_USE.has(folder.specialUse))
}

/** What a run learned about a folder's history; absent fields are left as they were. */
interface BackfillOutcome {
  complete?: boolean
  stopped?: 'days' | 'count' | null
}

interface FolderStateRow {
  uidvalidity?: string
  last_uid: string
  oldest_uid?: string
  highest_modseq?: string
}

async function syncFolder(instance: AppInstance, client: ImapFlow, path: string, lease: Lease, deadline: number): Promise<void> {
  const sql = await appDb()
  const limits = mailSyncLimits()
  const cutoff = new Date(Date.now() - limits.days * 86_400_000)

  const lock = await client.getMailboxLock(path, { readOnly: true, acquireTimeout: 30_000 })
  try {
    const mailbox = client.mailbox
    if (!mailbox) return
    const uidvalidity = String(mailbox.uidValidity)

    const [stored] = await sql<FolderStateRow[]>`
      SELECT uidvalidity::text AS uidvalidity, last_uid::text AS last_uid, oldest_uid::text AS oldest_uid,
             highest_modseq::text AS highest_modseq
      FROM app.mail_folders WHERE instance_id = ${instance.id} AND path = ${path}`
    let state: FolderStateRow = stored ?? { last_uid: '0' }

    if (state.uidvalidity !== undefined && state.uidvalidity !== uidvalidity) {
      console.warn(`[imap-sync] connection ${instance.id}: a folder was renumbered (UIDVALIDITY changed); resyncing it`)
      await sql`DELETE FROM app.mail_messages WHERE instance_id = ${instance.id} AND folder_path = ${path}`
      state = { last_uid: '0' }
      await sql`
        UPDATE app.mail_folders
        SET last_uid = 0, oldest_uid = NULL, highest_modseq = NULL, backfill_complete = false, backfill_stopped = NULL
        WHERE instance_id = ${instance.id} AND path = ${path}`
    }

    const save = (values: Record<string, unknown>) => sql`
      UPDATE app.mail_folders SET ${sql(values)}
      WHERE instance_id = ${instance.id} AND path = ${path}`

    let lastUid = Number(state.last_uid)
    let oldestUid = state.oldest_uid === undefined ? undefined : Number(state.oldest_uid)

    // ── first sight of this folder: the newest chunk inside the age limit ──
    const topUid = Number(mailbox.uidNext) - 1
    if (oldestUid === undefined) {
      const recent = await uidSearchWindowed(client, mailbox.exists, { since: cutoff }, 1, topUid, { descending: true, enough: BACKFILL_CHUNK })
      const newest = recent.sort((a, b) => b - a).slice(0, BACKFILL_CHUNK)
      await storeMessages(instance, client, path, uidvalidity, newest)
      lastUid = Math.max(newest[0] ?? 0, topUid, 0)
      oldestUid = newest.length ? newest[newest.length - 1]! : lastUid + 1
      await save({ uidvalidity, last_uid: lastUid, oldest_uid: oldestUid })
    }
    // ── new mail since the last run ──
    else if (topUid > lastUid) {
      const fresh = (await uidSearchWindowed(client, mailbox.exists, {}, lastUid + 1, topUid, { enough: NEW_CHUNK }))
        .filter(uid => uid > lastUid)
        .sort((a, b) => a - b)
        .slice(0, NEW_CHUNK)
      await storeMessages(instance, client, path, uidvalidity, fresh)
      if (fresh.length) lastUid = fresh[fresh.length - 1]!
      // Nothing above lastUid any more (they were expunged before we saw them).
      if (fresh.length < NEW_CHUNK) lastUid = Math.max(lastUid, topUid)
      await save({ uidvalidity, last_uid: lastUid })
    }

    // ── flag changes ──
    await refreshFlags(instance, client, path, state.highest_modseq, lastUid)

    // ── expunged messages ──
    const [counted] = await sql<Array<{ count: string }>>`
      SELECT count(*) FROM app.mail_messages WHERE instance_id = ${instance.id} AND folder_path = ${path}`
    let storedCount = Number(counted?.count ?? 0)
    if (lease.runs % EXPUNGE_EVERY === 0 || storedCount > mailbox.exists) {
      const present = await uidSearchWindowed(client, mailbox.exists, {}, 1, topUid)
      const result = await sql`
        DELETE FROM app.mail_messages
        WHERE instance_id = ${instance.id} AND folder_path = ${path}
          AND NOT (uid = ANY(${present}::bigint[]))`
      storedCount -= result.count
    }

    // ── backfill, newest first, inside the limits ──
    //
    // Whether the folder is complete is decided by **date, never by UID
    // position**. UIDs follow arrival order, and arrival is not sending: mail
    // imported or migrated into a folder lands old messages at its highest
    // UIDs. Reaching UID 1 therefore does not mean nothing older was skipped,
    // and a folder that said "complete" over a year of skipped mail would tell
    // the model there is no older mail when there is.
    const finished = async (): Promise<BackfillOutcome> =>
      (await uidSearchWindowed(client, mailbox.exists, { before: cutoff }, 1, topUid, { enough: 1 })).length
        ? { complete: false, stopped: 'days' }
        : { complete: true, stopped: null }

    let backfill: BackfillOutcome = {}
    if (oldestUid > 1 && Date.now() < deadline) {
      const older = (await uidSearchWindowed(client, mailbox.exists, { since: cutoff }, 1, oldestUid - 1, { descending: true, enough: BACKFILL_CHUNK }))
        .sort((a, b) => b - a)
      if (older.length && storedCount >= limits.max) {
        backfill = { complete: false, stopped: 'count' }
      }
      else if (older.length) {
        const chunk = older.slice(0, Math.min(BACKFILL_CHUNK, limits.max - storedCount))
        await storeMessages(instance, client, path, uidvalidity, chunk)
        oldestUid = chunk[chunk.length - 1]!
        await save({ oldest_uid: oldestUid })
      }
      else {
        backfill = await finished()
      }
    }
    else if (oldestUid <= 1) {
      backfill = await finished()
    }

    await save({
      server_messages: mailbox.exists,
      highest_modseq: mailbox.highestModseq === undefined ? null : String(mailbox.highestModseq),
      last_synced_at: new Date(),
      ...(backfill.complete !== undefined && { backfill_complete: backfill.complete }),
      ...(backfill.stopped !== undefined && { backfill_stopped: backfill.stopped }),
    })
  }
  finally {
    lock.release()
  }
}

/**
 * imapflow answers a failed SEARCH with `false`, not a rejection: a dropped
 * connection, or a reply past the line cap. Read as "no UIDs", that made the
 * expunge pass delete every synced row of the folder, so it throws instead and
 * the folder's run fails as a whole.
 */
async function uidSearch(client: ImapFlow, query: Parameters<ImapFlow['search']>[0]): Promise<number[]> {
  const result = await client.search(query, { uid: true })
  if (!Array.isArray(result)) throw new Error('IMAP SEARCH failed')
  return result
}

/** UIDs per SEARCH: at most 50,000 numbers of up to 11 bytes, about half the client's 1 MiB line cap. */
const SEARCH_UID_WINDOW = 50_000

/**
 * UID SEARCH asked in UID windows of `from`..`to`, so no single answer can
 * outgrow the line cap openImap sets. A server answers SEARCH on one line, and
 * an unbounded `ALL` or `BEFORE` on a large folder would fail the connection
 * (LineTooLarge) and stop the folder's sync. Walks the windows upward, or
 * downward with `descending`, and stops once `enough` UIDs are found, so
 * callers after the newest or oldest few pay for few round trips. A missing
 * UIDNEXT falls back to one open-ended search.
 *
 * A folder holding no more than one window's worth of messages (`exists`, from
 * the SELECT) is searched in one round trip whatever its UID range: an answer
 * cannot list more UIDs than the folder holds, and UID ranges are sparse — a
 * long-lived folder's UIDNEXT runs into the millions, which would otherwise be
 * dozens of searches per run for a few thousand messages. A server answering
 * with more than it holds still meets the line cap and fails the folder.
 */
async function uidSearchWindowed(
  client: ImapFlow,
  exists: number,
  query: Parameters<ImapFlow['search']>[0],
  from: number,
  to: number,
  options: { descending?: boolean, enough?: number } = {},
): Promise<number[]> {
  if (!Number.isFinite(to)) return uidSearch(client, { ...query, uid: `${from}:*` })
  const found: number[] = []
  if (to < from) return found
  if (exists <= SEARCH_UID_WINDOW) return uidSearch(client, { ...query, uid: `${from}:${to}` })
  const windows = Math.ceil((to - from + 1) / SEARCH_UID_WINDOW)
  for (let i = 0; i < windows; i++) {
    const low = from + (options.descending ? windows - 1 - i : i) * SEARCH_UID_WINDOW
    const high = Math.min(to, low + SEARCH_UID_WINDOW - 1)
    for (const uid of await uidSearch(client, { ...query, uid: `${low}:${high}` })) found.push(uid)
    if (options.enough !== undefined && found.length >= options.enough) break
  }
  return found
}

/**
 * Re-read flags. With CONDSTORE the server says what changed since the last
 * run; without it, the newest messages are re-read, which is where a person's
 * reading and flagging happens. Older flags may then lag — read state on a
 * year-old message is rarely the question.
 */
async function refreshFlags(
  instance: AppInstance,
  client: ImapFlow,
  path: string,
  highestModseq: string | undefined,
  lastUid: number,
): Promise<void> {
  if (lastUid < 1) return
  const sql = await appDb()
  const updates: Array<{ uid: number, flags: string[] }> = []

  if (client.enabled.has('CONDSTORE') && highestModseq) {
    for await (const message of client.fetch(`1:${lastUid}`, { uid: true, flags: true }, { uid: true, changedSince: BigInt(highestModseq) })) {
      updates.push({ uid: message.uid, flags: flagList(message.flags) })
    }
  }
  else {
    const rows = await sql<Array<{ uid: string }>>`
      SELECT uid::text AS uid FROM app.mail_messages
      WHERE instance_id = ${instance.id} AND folder_path = ${path}
      ORDER BY uid DESC LIMIT ${FLAG_REFRESH}`
    if (!rows.length) return
    for await (const message of client.fetch(rows.map(r => Number(r.uid)), { uid: true, flags: true }, { uid: true })) {
      updates.push({ uid: message.uid, flags: flagList(message.flags) })
    }
  }
  if (!updates.length) return

  // IMAP flags are atoms — no spaces — so a space-joined string round-trips.
  // Unchanged rows are skipped: Postgres writes a new row version even when the
  // value is equal, and without CONDSTORE nearly every row here is unchanged —
  // 500 rewrites per folder every run (#201). The comparison is order-sensitive,
  // which is why `flagList` sorts.
  await sql`
    UPDATE app.mail_messages m SET flags = string_to_array(v.flags, ' ')
    FROM unnest(${updates.map(u => u.uid)}::bigint[], ${updates.map(u => u.flags.join(' '))}::text[]) AS v(uid, flags)
    WHERE m.instance_id = ${instance.id} AND m.folder_path = ${path} AND m.uid = v.uid
      AND m.flags IS DISTINCT FROM string_to_array(v.flags, ' ')`
}

/**
 * A message's flags in a fixed order. imapflow hands them over as a Set in the
 * server's order, which a server may vary between fetches; stored unsorted, the
 * unchanged-flags check in `refreshFlags` would read a reshuffle as a change.
 */
function flagList(flags: Set<string> | undefined): string[] {
  return [...(flags ?? [])].sort()
}

/** Fetch headers for `uids` in batches and upsert them. Bodies are not fetched. */
async function storeMessages(
  instance: AppInstance,
  client: ImapFlow,
  path: string,
  uidvalidity: string,
  uids: number[],
): Promise<void> {
  if (!uids.length) return
  const sql = await appDb()

  for (let i = 0; i < uids.length; i += 100) {
    const batch = uids.slice(i, i + 100)
    // Keyed by UID: a server answering one UID twice would otherwise fail the
    // batch with 21000, as a duplicated folder does above; the later answer wins.
    const byUid = new Map<number, ReturnType<typeof toRow>>()
    for await (const message of client.fetch(batch, {
      uid: true,
      envelope: true,
      flags: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
      headers: ['references'],
    }, { uid: true })) {
      const row = toRow(instance.id, path, uidvalidity, message)
      byUid.set(row.uid, row)
    }
    if (!byUid.size) continue
    const rows = [...byUid.values()]

    try {
      await upsertMessages(rows)
    }
    catch (cause) {
      if (!isDataError(cause)) throw cause
      // One row the database refuses must not fail the other 99, and must not
      // hold the folder's cursor behind it: the next run would select the
      // same UIDs and fail on the same row, so no later mail in the folder
      // would ever be stored (GHSA-89q9-r9vm-6vp2). Each row on its own, then
      // a refused one again with every sender-chosen field dropped.
      let degraded = 0
      for (const row of rows) {
        try {
          await upsertMessages([row])
        }
        catch (rowCause) {
          if (!isDataError(rowCause)) throw rowCause
          await upsertMessages([degradedRow(row)])
          degraded++
        }
      }
      if (degraded) {
        console.error(`[imap-sync] connection ${instance.id}: stored ${degraded} message(s) without their headers, which the database refused`, cause)
      }
    }
  }
}

async function upsertMessages(rows: Array<ReturnType<typeof toRow>>): Promise<void> {
  const sql = await appDb()
  await sql`
    INSERT INTO app.mail_messages ${sql(rows)}
    ON CONFLICT (instance_id, folder_path, uid) DO UPDATE
    SET uidvalidity = EXCLUDED.uidvalidity, message_id = EXCLUDED.message_id,
        in_reply_to = EXCLUDED.in_reply_to, refs = EXCLUDED.refs, subject = EXCLUDED.subject,
        from_addr = EXCLUDED.from_addr, to_addr = EXCLUDED.to_addr, cc_addr = EXCLUDED.cc_addr,
        sent_at = EXCLUDED.sent_at, received_at = EXCLUDED.received_at, flags = EXCLUDED.flags,
        size = EXCLUDED.size, text_part = EXCLUDED.text_part, html_part = EXCLUDED.html_part,
        attachments = EXCLUDED.attachments`
}

/**
 * SQLSTATE class 22 (data exception: bad json, bad encoding, value too long):
 * the row's content, not the database, is at fault, so the row can be retried
 * alone. Anything else — the database gone, a constraint — fails the batch.
 */
function isDataError(cause: unknown): boolean {
  const code = (cause as { code?: unknown })?.code
  return typeof code === 'string' && code.startsWith('22')
}

/**
 * A message kept with only what the server, not the sender, decided: its UID,
 * dates, flags, size and body part numbers. Listed with no subject or sender
 * rather than left out, and its body still readable through `read-email`.
 */
function degradedRow(row: ReturnType<typeof toRow>): ReturnType<typeof toRow> {
  return {
    ...row,
    message_id: undefined,
    in_reply_to: undefined,
    refs: [],
    subject: '',
    from_addr: [],
    to_addr: [],
    cc_addr: [],
    flags: row.flags.filter(flag => /^[\x21-\x7e]+$/.test(flag)),
    attachments: [],
  }
}

function toRow(instanceId: string, path: string, uidvalidity: string, message: FetchMessageObject) {
  const envelope = message.envelope ?? {}
  const parts = messagePartsOf(message.bodyStructure)
  const received = validDate(message.internalDate) ?? validDate(envelope.date) ?? new Date()

  return {
    instance_id: instanceId,
    folder_path: path,
    uidvalidity,
    uid: message.uid,
    message_id: cleanText(envelope.messageId, 998),
    in_reply_to: cleanText(envelope.inReplyTo, 998),
    refs: parseReferences(message.headers),
    subject: cleanText(envelope.subject, 2000) ?? '',
    from_addr: addresses(envelope.from),
    to_addr: addresses(envelope.to),
    cc_addr: addresses(envelope.cc),
    sent_at: validDate(envelope.date),
    received_at: received,
    flags: flagList(message.flags),
    size: message.size,
    text_part: parts.textPart,
    html_part: parts.htmlPart,
    attachments: parts.attachments,
  }
}

/** At most 50 addresses per header: a mass mailing's To line is not worth a megabyte. */
function addresses(list: MessageAddressObject[] | undefined) {
  return (list ?? []).slice(0, 50).flatMap((entry) => {
    const name = cleanText(entry.name, 200)
    const address = cleanText(entry.address, 320)
    return name || address ? [{ ...(name && { name }), ...(address && { address }) }] : []
  })
}

function validDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** `References:` as a list of message ids, capped — threads can carry hundreds. */
function parseReferences(headers: Buffer | undefined): string[] {
  if (!headers) return []
  const ids = headers.toString('utf8').replace(/\0/g, '').match(/<[^<>\s]+>/g) ?? []
  return ids.slice(-50)
}
