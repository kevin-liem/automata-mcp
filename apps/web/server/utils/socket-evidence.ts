import type { AppInstance } from './app-db'
import { rememberBounded } from './lookup-cache'

/**
 * Evidence that a WhatsApp account's socket is dead while Evolution's live
 * state still reads `open` — `socket_dead_seen_at` on `app.instances` (#205).
 *
 * **Why the live state is not enough.** `getInstanceStatus` takes `state` from
 * Evolution's in-memory `connectionState`, because the stored column goes stale
 * (see there). The in-memory value can go stale too: production ran nine hours
 * with every send failing `Connection Closed`, group lookups failing the same
 * way, and `connectionState`, the column, and the row-churn reading all saying
 * healthy — most likely the account's serial `eventProcessingQueue` stuck when
 * its database writes failed during a Postgres restart. No read we make can
 * tell; only a call that needs the socket finds out, and the two such calls we
 * make — a send and a group lookup — used to log the failure and drop it.
 *
 * So those two record it here, and `readStatus` judges it (`socketStalled` in
 * instances.ts) into `stalled`, which alerts like `flapping`: the fix is a
 * restart of the Evolution service, never Reconnect (which answers 409 from
 * `open`) and never `/instance/restart` (#103).
 *
 * Rules easy to undo:
 *
 *   - **Only from a call this app made and Evolution answered.** Never from a
 *     webhook payload: deliveries are unsigned, and a stranger must not be able
 *     to mail a user that their account is dead — same rule as row churn.
 *   - **Only Baileys' definitive socket texts** (`DEAD_SOCKET`). `Timed Out` is
 *     left out on purpose: WhatsApp answering one `groupMetadata` slowly on a
 *     healthy socket would otherwise become an outage mail on an idle account,
 *     where no later success comes along to clear it. A dead socket answers
 *     `Connection Closed` straight away, which is what production showed.
 *   - **At most one write a minute per connection** (conditional UPDATE, plus an
 *     in-memory gate so a burst of failures costs one statement), and the value
 *     written is truncated to milliseconds, so the ISO string a row read hands
 *     back compares equal to what is stored (`forgetSocketEvidence`).
 *   - **Cleared by any socket call that succeeds** — a send, a group lookup
 *     WhatsApp answered (including "not a member" and "rate-overlimit": both
 *     came over the socket). Also superseded by Evolution reopening the socket,
 *     which `readStatus` sees from the row's write time.
 *   - Best effort: a failed write is logged, never thrown into the request that
 *     found the evidence — that request is already failing for its own reason.
 */

/**
 * Baileys' own errors for a socket that is not there, as Evolution relays them
 * (`Error: Connection Closed`, and the wording of the not-connected checks).
 * Matched only against the texts in Evolution's error body, never against the
 * fetch error's own message — our request timing out is not WhatsApp's socket.
 */
const DEAD_SOCKET = /connection closed|not connected|connection lost/i

/** Whether Evolution's error texts name a dead socket. */
export function namesDeadSocket(texts: readonly string[]): boolean {
  return texts.some(text => DEAD_SOCKET.test(text))
}

/** Shortest gap between two evidence writes for one connection. */
const EVIDENCE_WRITE_INTERVAL_MS = 60_000

/** Per process: when this process last wrote evidence for a connection. */
const lastWritten = new Map<string, number>()
const MAX_LAST_WRITTEN = 10_000

/**
 * Record that a call needing the socket found it dead. Fire and forget.
 * `what` is for the log only — "send", "group lookup".
 */
export function noteSocketDead(instance: Pick<AppInstance, 'id'>, what: string): void {
  const now = Date.now()
  const last = lastWritten.get(instance.id)
  if (last !== undefined && now - last < EVIDENCE_WRITE_INTERVAL_MS) return
  rememberBounded(lastWritten, instance.id, now, MAX_LAST_WRITTEN)

  storeSocketDead(instance.id, what).catch((error) => {
    lastWritten.delete(instance.id)
    console.error(`[socket] could not record the dead socket seen on connection ${instance.id}:`, error)
  })
}

async function storeSocketDead(instanceId: string, what: string): Promise<void> {
  const sql = await appDb()
  const written = await sql`
    UPDATE app.instances
    SET socket_dead_seen_at = date_trunc('milliseconds', now())
    WHERE id = ${instanceId}
      AND (socket_dead_seen_at IS NULL OR socket_dead_seen_at < now() - interval '1 minute')
    RETURNING id
  `
  if (written.length) {
    console.warn(`[socket] connection ${instanceId}: a ${what} found the WhatsApp socket dead; recorded for the health check`)
  }
}

/**
 * Record that a call needing the socket got an answer. Fire and forget, and a
 * no-op unless there is evidence to clear — the row as loaded says so, or this
 * process wrote some since — so a healthy account's sends cost no write.
 */
export function noteSocketAlive(instance: Pick<AppInstance, 'id' | 'socket_dead_seen_at'>): void {
  if (!instance.socket_dead_seen_at && !lastWritten.has(instance.id)) return
  lastWritten.delete(instance.id)

  clearSocketDead(instance.id).catch((error) => {
    console.error(`[socket] could not clear the dead-socket evidence of connection ${instance.id}:`, error)
  })
}

async function clearSocketDead(instanceId: string): Promise<void> {
  const sql = await appDb()
  const cleared = await sql`
    UPDATE app.instances SET socket_dead_seen_at = NULL
    WHERE id = ${instanceId} AND socket_dead_seen_at IS NOT NULL
    RETURNING id
  `
  if (cleared.length) {
    console.info(`[socket] connection ${instanceId}: a socket call succeeded; dead-socket evidence cleared`)
  }
}

/**
 * Drop evidence a status read found superseded — Evolution reopened the socket
 * since, or the account is now plainly not `open`. Only the value that read saw:
 * evidence written meanwhile is newer than the read's verdict and stays.
 * Fire and forget.
 */
export function forgetSocketEvidence(instanceId: string, seenAt: string): void {
  lastWritten.delete(instanceId)
  appDb()
    .then(sql => sql`
      UPDATE app.instances SET socket_dead_seen_at = NULL
      WHERE id = ${instanceId} AND socket_dead_seen_at <= ${seenAt}::timestamptz
    `)
    .catch((error) => {
      console.error(`[socket] could not clear superseded dead-socket evidence of connection ${instanceId}:`, error)
    })
}
