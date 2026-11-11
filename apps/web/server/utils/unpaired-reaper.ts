import type { AppInstance } from './app-db'

/**
 * Delete WhatsApp connections that were never paired, `UNPAIRED_TTL_MS` after
 * they were created. Registered as the `instances:reap-unpaired` task.
 *
 * An abandoned pairing is not inert (ju-li/automata-mcp#105): Evolution keeps
 * the instance `connecting` and prints a fresh QR to its log every few minutes,
 * reconnects it at every boot, the hourly task re-registers its webhook, and in
 * hosted mode it holds one of the organization's `max_connections`.
 *
 * Rules, each easy to undo:
 *
 * - **Never on `ownerJid` alone.** Evolution 2.3.7 keeps `ownerJid` through a
 *   logout, but it is still Evolution's fact, absent whenever Evolution can't be
 *   read, and deleting a connection that was paired throws away its tokens and
 *   access to its history. Candidates are rows with no
 *   `paired_at` — our own record, see `notePaired` — and each is re-asked live
 *   (`pairingEvidence`) just before deletion, so a scan at minute 59 wins. A
 *   read that fails is never a reason to delete.
 * - **Only through `deleteInstance()`**, never a bare `DELETE`: it removes the
 *   instance from Evolution first and keeps the row if that fails. A row whose
 *   Evolution server this deployment cannot authenticate to is skipped rather
 *   than deleted — dropping it would leave the QR churning with nothing
 *   recording it, the opposite of the point.
 * - **Claimed by a conditional-UPDATE lease** (`reap_lease_until`), so two
 *   replicas never both ask Evolution to delete one instance.
 * - **The outbox row commits with the delete**, with `reason:
 *   'unpaired_expired'` so it can be told apart from a person's delete.
 *
 * Bring-your-own Evolution servers included: an unpaired connection is as
 * useless there, and the delete uses that row's own key. Telegram is out of
 * scope — an unlinked session on the bridge holds no socket and polls nothing.
 */

/** Longer than one candidate's probe and delete can take; shorter than the task interval. */
const REAP_LEASE_MS = 5 * 60_000
/** Per run, so one slow Evolution cannot hold the task for long. The rest wait ten minutes. */
const REAP_BATCH = 25

/** Rows already reported as undecidable, so a long outage logs once per process, not every run. */
const undecidedLogged = new Set<string>()

export async function reapUnpairedConnections(): Promise<{ candidates: number, reaped: number, failed: number }> {
  const sql = await appDb()
  const ttlSecs = UNPAIRED_TTL_MS / 1000
  const leaseSecs = REAP_LEASE_MS / 1000

  const candidates = await sql<Array<{ id: string, org: string }>>`
    SELECT id, org FROM app.instances
    WHERE kind = 'whatsapp'
      AND paired_at IS NULL
      AND created < now() - make_interval(secs => ${ttlSecs})
      AND (reap_lease_until IS NULL OR reap_lease_until < now())
    ORDER BY created
    LIMIT ${REAP_BATCH}
  `

  let reaped = 0
  let failed = 0

  // A few at once, like the alert sweep: each candidate may wait out a
  // deadline on its own server, and one at a time a batch could outlast the
  // task's interval. The per-row lease makes concurrent claims safe. No
  // deadline here — reapOne bounds the read that can hang.
  await forEachBounded(candidates, {
    concurrency: CONNECTION_WORK_CONCURRENCY,
    onError: ({ id, org }, error) => {
      failed++
      // Handled, so Nitro logs nothing. The lease lapses and the next run retries.
      console.error(`[reaper] could not delete unpaired connection ${id} (org ${org}):`, error)
    },
  }, async ({ id }) => {
    // The claim re-reads the row, so a pairing recorded since the SELECT, or
    // another replica's lease, ends this here.
    const [instance] = await sql<AppInstance[]>`
      UPDATE app.instances
      SET reap_lease_until = now() + make_interval(secs => ${leaseSecs})
      WHERE id = ${id}
        AND kind = 'whatsapp'
        AND paired_at IS NULL
        AND created < now() - make_interval(secs => ${ttlSecs})
        AND (reap_lease_until IS NULL OR reap_lease_until < now())
      RETURNING *
    `
    if (instance && await reapOne(instance)) reaped++
  })

  return { candidates: candidates.length, reaped, failed }
}

async function reapOne(instance: AppInstance): Promise<boolean> {
  // Bounded: the evidence comes from the connection's own Evolution server and
  // message database, which for a bring-your-own one is whoever signed up's to
  // run — and a server that never finishes its answer would otherwise hold this
  // run, and through Nitro's `runTask` every later one (GHSA-g2cf-mx92-xc53). A
  // missed deadline is a read that failed: `unknown`, kept, never deleted.
  const verdict = await withDeadline(pairingEvidence(instance), CONNECTION_WORK_DEADLINE_MS, `pairing evidence for ${instance.id}`)
    .catch((): 'unknown' => 'unknown')

  if (verdict === 'paired') {
    undecidedLogged.delete(instance.id)
    console.info(`[reaper] connection ${instance.id} (org ${instance.org}) is paired; recorded and kept`)
    return false
  }

  if (verdict === 'unknown') {
    if (!undecidedLogged.has(instance.id)) {
      undecidedLogged.add(instance.id)
      console.warn(
        `[reaper] connection ${instance.id} (org ${instance.org}) was never seen paired, but its Evolution `
        + 'server or database could not be asked; kept until it can be.',
      )
    }
    return false
  }

  if (!evolutionAdminCredentials(instance)) {
    if (!undecidedLogged.has(instance.id)) {
      undecidedLogged.add(instance.id)
      console.warn(
        `[reaper] connection ${instance.id} (org ${instance.org}) was never paired, but no admin key is `
        + 'available for its Evolution server, so it cannot be removed there; kept.',
      )
    }
    return false
  }

  await deleteInstance(instance, {
    event: {
      type: 'connection.deleted',
      org: instance.org,
      payload: { id: instance.id, kind: 'whatsapp', reason: 'unpaired_expired' },
    },
  })
  undecidedLogged.delete(instance.id)
  console.info(
    `[reaper] deleted connection ${instance.id} (org ${instance.org}): not paired within `
    + `${UNPAIRED_TTL_MS / 60_000} minutes of being created`,
  )
  return true
}
