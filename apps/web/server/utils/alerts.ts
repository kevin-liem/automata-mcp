import type { AppInstance } from './app-db'
import type { RowChurn } from './instances'
import { assertNever } from '#shared/connection'
import type { ConnectionState, InstanceKind } from '#shared/connection'

/**
 * Telling the people who use a connection that it died.
 *
 * Two things feed this, and they are not redundant:
 *
 *   the webhook  `connection.update` from Evolution or the Telegram bridge,
 *                which arrives within seconds of a logout, a ban, a replaced
 *                or a revoked session.
 *   the sweep    a five-minute pass over every WhatsApp and Telegram connection.
 *
 * The sweep is not a backstop for a flaky webhook — it is the only thing that
 * sees the failure that matters most. In 2.3.7 a close Evolution intends to
 * retry emits **no** `connection.update` at all (`connectionUpdate` in
 * whatsapp.baileys.service.ts reconnects and returns), so a socket that dies and
 * never comes back is silent on the webhook forever. That is the same failure
 * `sessionLost` exists for, and only a live read finds it.
 *
 * Both paths end up in `evaluateConnectionHealth`, and neither one reads a state
 * out of a webhook payload. The global webhook sends no headers, so a delivery
 * may be unauthenticated and anyone can post one; treating its `state` as fact
 * would let a stranger mail a user that their connection is down. The payload
 * says *look at this connection*, and `readConnectionHealth()` says what is true.
 */

/**
 * One connection's health, in the terms alerting needs, whatever its kind.
 *
 * Built from a live read — `getInstanceHealth()` for WhatsApp, the bridge's
 * `/state` for Telegram — and never from a stored column.
 */
type ConnectionHealth = {
  kind: 'whatsapp' | 'telegram'
  state: ConnectionState
  /** Linked, and the transport dropped. Reconnect is enough. */
  sessionLost: boolean
  /**
   * WhatsApp only: Evolution keeps reopening the socket — see `rowChurn` in
   * instances.ts. Reconnect cannot help; restarting the Evolution service does.
   */
  flapping: boolean
  /**
   * WhatsApp only: reads `open`, but a send or group lookup found the socket
   * dead since Evolution last opened it — see `socketStalled` in instances.ts.
   * Same fix as `flapping`: restart the Evolution service.
   */
  stalled: boolean
  /**
   * The connection has been linked at some point, so a bad state is an outage
   * rather than a connection nobody has finished setting up.
   */
  paired: boolean
  /**
   * The source said, definitively, that nothing is linked. Only then is an open
   * outage closed without a mail — see `evaluateConnectionHealth`.
   */
  knownUnlinked: boolean
  /** Telegram ended the session. Only linking again by QR recovers it. */
  revoked: boolean
  /** Telegram only: the bridge could not be asked at all. */
  unreachable: boolean
  /** Telegram only: another bridge process holds the session. */
  heldElsewhere: boolean
}

/**
 * Read one connection's live health. Throws only where the underlying read
 * does; both reads report an unreachable backend as `unknown` instead. For
 * WhatsApp it also stores the reconnect-loop observation the read produced
 * (`storeRowChurn`), since that verdict is built across reads.
 *
 * **What "paired" means differs by kind, and both answers are deliberate.**
 *
 * WhatsApp: `ownerJid`. A fresh instance and a logout both leave Evolution in
 * `close`, and `ownerJid` is the only thing that tells them apart: 2.3.7 writes
 * it when the socket opens and never clears it — logout's `cleaningUp` sets
 * `connectionStatus` alone. It is also
 * absent when Evolution cannot be reached, so an Evolution outage is invisible
 * here — which is today's behaviour, and nothing can say more without a stored
 * "was linked" fact.
 *
 * Telegram: the bridge keeps the account's identity (`me`) on the session row
 * through a dropped connection and through a revocation, and clears it only on
 * logout — so its presence is "was linked and not deliberately unlinked". A
 * bridge that cannot be reached answers `unknown` with no identity, and that is
 * counted as paired: a connection this server cannot check is one its users
 * cannot use, and the deployment's bridge going down is precisely what an
 * operator needs to hear about. The cost is that a connection nobody has linked
 * yet also mails once during a bridge outage — with wording that is true for it.
 */
async function readConnectionHealth(instance: AppInstance, kind: 'whatsapp' | 'telegram'): Promise<ConnectionHealth> {
  switch (kind) {
    case 'whatsapp': {
      // Health only: this runs per connection every five minutes and reads none
      // of the counts, so it must not cause one to be computed.
      const status = await getInstanceHealth(instance)
      await storeRowChurn(instance, status.rowChurn, Boolean(status.flapping))
      return {
        kind,
        state: status.state,
        sessionLost: Boolean(status.sessionLost),
        flapping: Boolean(status.flapping),
        stalled: Boolean(status.stalled),
        paired: Boolean(status.ownerJid),
        knownUnlinked: false,
        revoked: false,
        unreachable: false,
        heldElsewhere: false,
      }
    }
    case 'telegram': {
      const status = await getTelegramStatus(instance)
      const linked = Boolean(status.telegramUserId)
      const unreachable = status.state === 'unknown' && !linked
      return {
        kind,
        state: status.state,
        sessionLost: Boolean(status.sessionLost),
        flapping: false,
        stalled: false,
        paired: linked || unreachable,
        knownUnlinked: !linked && !unreachable,
        revoked: Boolean(status.revoked),
        unreachable,
        heldElsewhere: Boolean(status.heldElsewhere),
      }
    }
    default:
      return assertNever(kind)
  }
}

/**
 * Persist the churn observation a WhatsApp health read produced — this file is
 * the only writer of `row_churn_since` / `row_churn_seen_at`, as it is of
 * `down_since` and `alerted_at`. Written only when it changed, and with plain
 * SQL rather than `updateRow`, so bookkeeping every sweep does not move the
 * connection's `updated` stamp.
 *
 * Logs once per episode, when it first amounts to a loop. The fix is the
 * operator's — restarting the Evolution service — and the organization's mail
 * does not reach them; with `NUXT_OPS_ALERT_EMAIL` set they are also mailed
 * (`reportLoopToOperator`).
 */
async function storeRowChurn(instance: AppInstance, churn: RowChurn, flapping: boolean): Promise<void> {
  const since = instance.row_churn_since
  const seenAt = instance.row_churn_seen_at
  if (churn.since === since && churn.seenAt === seenAt) return

  const sql = await appDb()
  await sql`
    UPDATE app.instances
    SET row_churn_since = ${churn.since ?? null}, row_churn_seen_at = ${churn.seenAt ?? null}
    WHERE id = ${instance.id}
  `

  const wasFlapping = isFlapping({ since, seenAt })
  if (flapping && !wasFlapping) {
    console.error(
      `[alerts] WhatsApp connection ${instance.id} (${instance.name}) has been reconnecting continuously `
      + `since ${churn.since}: Evolution keeps reopening its socket while the stored status reads open. `
      + 'Reconnect cannot end this; restart the Evolution service (no QR scan needed). See docs/whatsapp.md.',
    )
  }
}

/**
 * The kinds alerting covers. Postgres has no liveness signal short of a timed
 * connection. A mailbox's sync failing shows on its dashboard but is not mailed
 * yet — the sync's `auth_failed` is the signal that would drive it.
 */
function alertableKind(instance: AppInstance): 'whatsapp' | 'telegram' | undefined {
  const kind: InstanceKind = instanceKind(instance)
  switch (kind) {
    case 'whatsapp':
    case 'telegram':
      return kind
    case 'postgres':
    case 'imap':
      return undefined
    default:
      return assertNever(kind)
  }
}

/**
 * How long a connection must be unhealthy before anyone is told.
 *
 * Every unhealthy state serves it out, a live `close` included. Short drops that
 * recover on their own are common enough that mailing on the first `close`
 * meant an outage mail followed seconds later by a recovery mail; a connection
 * that recovers inside the window mails nobody. The sweep runs every five
 * minutes, so an outage that outlasts the grace is reported within five minutes
 * of the grace running out.
 */
const GRACE_MS = 10 * 60 * 1000

/**
 * Decide, for one connection, whether anything needs to be said.
 *
 * Idempotent, and safe to call as often as you like — the two date fields on the
 * row are what make it so. `down_since` empty means healthy; `alerted_at` set
 * means the current outage has already been reported, which is what stops the
 * sweep from mailing every five minutes.
 *
 * A connection that has never been paired is skipped entirely. A fresh instance
 * sits in `close` until somebody scans its QR code, and that is not an outage —
 * see `readConnectionHealth` for what tells the two apart per kind.
 *
 * Mail failures deliberately do not advance the state: `alerted_at` is written
 * only once a message actually went out, so a broken SMTP configuration means a
 * late alert rather than a lost one.
 *
 * Concurrent calls for one connection share one evaluation. The webhook and the
 * sweep can land together — registering a Telegram webhook to a new URL makes
 * the bridge deliver the current state straight away — and two evaluations that
 * both read `alerted_at` empty would both mail.
 *
 * Bounded for every caller, sweep and webhook alike: a bring-your-own server
 * that never finishes its answer must not hold either (GHSA-g2cf-mx92-xc53).
 * The deadline stops the waiting, not the evaluation, which stays in
 * `inFlight` until it settles — so a late one can never run beside a second
 * and mail twice.
 */
export function evaluateConnectionHealth(instance: AppInstance): Promise<void> {
  let evaluation = inFlight.get(instance.id)
  if (!evaluation) {
    evaluation = evaluate(instance).finally(() => inFlight.delete(instance.id))
    inFlight.set(instance.id, evaluation)
  }
  return withDeadline(evaluation, CONNECTION_WORK_DEADLINE_MS, `evaluating connection ${instance.id}`)
}

/** Per worker, like the webhook cooldown. The sweep and the webhook run in the same one. */
const inFlight = new Map<string, Promise<void>>()

async function evaluate(instance: AppInstance): Promise<void> {
  const kind = alertableKind(instance)
  if (!kind) return

  const health = await readConnectionHealth(instance, kind)

  // Before the paired check, and with no grace: the operator is the one person
  // who can end a loop or unstick a session, so they hear about it as soon as
  // it amounts to one. Its failure is logged and does not stop the
  // organization's own alert. Kind-agnostic: only WhatsApp health can be
  // `flapping` or `stalled`, and only a WhatsApp row ever carries
  // `ops_alerted_at`.
  await reportLoopToOperator(instance, health).catch((error) => {
    console.error(`[alerts] could not report connection ${instance.id}'s stuck session to the operator:`, error)
  })

  if (!health.paired) {
    // Unlinked on purpose — a Telegram logout clears the account — while an
    // outage was open. Nothing is broken any more and nothing is working
    // either, so neither mail is true; close the outage quietly, or linking
    // again later would send a "connected again" for an outage long over.
    if (health.knownUnlinked && (instance.down_since || instance.alerted_at)) {
      await updateRow('instances', instance.id, { down_since: null, alerted_at: null })
    }
    return
  }

  // A loop reads `open` on most live reads — whichever socket just logged in —
  // and a stuck session reads `open` on all of them, so without the last two
  // clauses both are healthy by construction.
  const healthy = health.state === 'open' && !health.sessionLost && !health.flapping && !health.stalled

  if (healthy) {
    if (!instance.down_since && !instance.alerted_at) return

    if (instance.alerted_at) {
      // Nobody was told it broke, so there is nothing to say about it working.
      const sent = await notifyWatchers(instance, () => recoveryMail(instance, health))
      if (!sent) return
    }

    await updateRow('instances', instance.id, { down_since: null, alerted_at: null })
    return
  }

  if (!instance.down_since) {
    await updateRow('instances', instance.id, { down_since: new Date() })
  }

  if (instance.alerted_at) return

  const downSince = instance.down_since ? Date.parse(instance.down_since) : Date.now()
  if (Date.now() - downSince < GRACE_MS) return

  const sent = await notifyWatchers(instance, canManage => outageMail(instance, health, canManage))
  if (sent) await updateRow('instances', instance.id, { alerted_at: new Date() })
}

/**
 * The five-minute pass. Registered as the `alerts:sweep` scheduled task.
 *
 * Every connection is wrapped on its own: one unreachable Evolution server or
 * Telegram bridge must not decide that the connections after it in the list go
 * unchecked. The failure is logged per connection — a handled error is
 * invisible to Nitro, and "the sweep quietly did half its work" is the exact
 * shape of problem that goes unnoticed for a week.
 *
 * **Wrapped means bounded, not just caught (GHSA-g2cf-mx92-xc53).** A `catch`
 * handles a rejection, never a promise that does not settle — and a
 * bring-your-own server is chosen by whoever signed up, so it can answer with
 * headers and then trickle its body for ever. Unbounded, the sweep stalls on
 * that connection, and Nitro's `runTask` hands every later tick the same pending
 * run, so no other tenant's connection is ever checked again in this process.
 * Each evaluation therefore has a deadline, and a few run at once. An
 * evaluation past its deadline keeps running and may still finish; that is
 * harmless, since `evaluateConnectionHealth` shares one in-flight evaluation per
 * connection and writes only what it read.
 *
 * A connection whose status read fails reads as `unknown`, which is unhealthy.
 * That is the honest answer: a connection this server cannot reach is one its
 * users cannot use either. It costs one grace period before anything is sent.
 */
export async function sweepConnectionAlerts(): Promise<{ checked: number, failed: number }> {
  const sql = await appDb()

  // Database connections have no liveness signal short of opening a connection
  // on a timer, and are out of scope.
  const instances = await sql<AppInstance[]>`
    SELECT * FROM app.instances WHERE kind IN ('whatsapp', 'telegram') ORDER BY created
  `

  let failed = 0

  // No deadline here: evaluateConnectionHealth carries its own, for the
  // webhook too, and a second identical one could never fire first.
  await forEachBounded(instances, {
    concurrency: CONNECTION_WORK_CONCURRENCY,
    onError: (instance, error) => {
      failed++
      console.error(`[alerts] could not evaluate connection ${instance.id} (${instance.name}):`, error)
    },
  }, instance => evaluateConnectionHealth(instance))

  return { checked: instances.length, failed }
}

/**
 * Re-assert every WhatsApp and Telegram connection's webhook. Registered as the
 * hourly `alerts:register-webhooks` task, apart from the sweep so the sweep can
 * run often without a registration call per connection each time.
 *
 * Re-asserted rather than assumed: this heals a connection created before
 * alerting existed, one whose server or bridge was rebuilt, and one whose
 * registration failed at provision time (where it is deliberately non-fatal).
 */
export async function reregisterConnectionWebhooks(): Promise<{ registered: number }> {
  const sql = await appDb()
  const instances = await sql<AppInstance[]>`
    SELECT * FROM app.instances WHERE kind IN ('whatsapp', 'telegram') ORDER BY created
  `
  // Bounded per connection for the same reason as the sweep: a server that
  // never finishes its answer must not stall registration for everyone after it.
  await forEachBounded(instances, {
    concurrency: CONNECTION_WORK_CONCURRENCY,
    deadlineMs: CONNECTION_WORK_DEADLINE_MS,
    what: instance => `registering connection ${instance.id}'s webhook`,
    // Other failures stay as quiet as before; a missed deadline is new, and a
    // handled one is otherwise invisible.
    onError: (_, error) => {
      if (error instanceof DeadlineExceededError) console.warn(`[alerts] ${error.message}`)
    },
  }, instance => registerWebhookFor(instance))
  return { registered: instances.length }
}

function registerWebhookFor(instance: AppInstance): Promise<void> {
  switch (alertableKind(instance)) {
    case 'whatsapp': return registerConnectionWebhook(instance)
    case 'telegram': return registerTelegramWebhook(instance)
    default: return Promise.resolve()
  }
}

interface AlertMail {
  subject: string
  text: string
}

// ── the operator ───────────────────────────────────────────────────────────

/** `NUXT_OPS_ALERT_EMAIL`, trimmed. Empty: no operator mail. */
function opsAlertEmail(): string {
  return String(useRuntimeConfig().opsAlertEmail ?? '').trim()
}

/**
 * Whether the operator of this deployment is mailed about a stuck session — a
 * reconnect loop or a dead socket under a live `open` — on this connection: an operator address is set, mail can go out, and the
 * connection is on the deployment's own Evolution server. A server the
 * organization supplied is theirs to restart, and its loops are not ours to
 * report.
 */
function operatorMailedAboutLoops(instance: Pick<AppInstance, 'admin_key' | 'base_url'>): boolean {
  return Boolean(opsAlertEmail()) && Boolean(useRuntimeConfig().smtpHost) && onDeploymentServer(instance)
}

/**
 * Whether what a customer reads about a stuck session on this connection — a
 * reconnect loop (`flapping`) or a dead socket under a live `open` (`stalled`) —
 * may say "this is on our side, we have been alerted". The one rule behind the
 * outage mail, the dashboard notice and `operatorAlerted` on the status that
 * MCP returns — so the three cannot disagree.
 *
 * Hosted mode only. On a self-hosted deployment the reader is often the
 * operator, and the existing wording ("whoever runs this deployment") is right
 * whether or not an operator address is set. On the hosted offering the promise
 * is only true if somebody is actually told, hence the operator address is part
 * of the rule rather than assumed.
 */
export function operatorAlertedAboutLoop(instance: Pick<AppInstance, 'admin_key' | 'base_url'>): boolean {
  return hostedMode() && operatorMailedAboutLoops(instance)
}

/**
 * Mail the deployment's operator when a WhatsApp connection on its Evolution
 * server starts looping or is found stuck (`stalled`), and again when that has
 * ended. One episode either way: a session that goes from one to the other
 * keeps its claim, so the operator is not mailed twice for one restart.
 *
 * The only operator signal before this was the `storeRowChurn` log line, which
 * nobody watches; in practice a loop was heard about when a customer replied to
 * the outage mail. No grace period: the organization's mail waits ten minutes
 * because most drops recover by themselves, and a loop does not — `flapping`
 * already takes ten minutes of churn to become true.
 *
 * `ops_alerted_at` is the bookkeeping, as `alerted_at` is for the organization:
 * claimed by a conditional UPDATE *before* sending, so two replicas or the sweep
 * and a webhook landing together cannot both mail, and put back if the send
 * failed, so broken SMTP delays the mail rather than losing it. The same claim
 * guards the "ended" mail. With no operator address any more, a stale claim is
 * cleared without mail once the loop ends.
 *
 * The mail names the connection by ids only — no label, no address, nothing
 * the organization typed — since its reader needs to find the instance, not
 * the customer.
 */
async function reportLoopToOperator(instance: AppInstance, health: ConnectionHealth): Promise<void> {
  const to = opsAlertEmail()

  if (health.flapping || health.stalled) {
    if (instance.ops_alerted_at || !operatorMailedAboutLoops(instance)) return

    const sql = await appDb()
    const claimed = await sql`
      UPDATE app.instances SET ops_alerted_at = now()
      WHERE id = ${instance.id} AND ops_alerted_at IS NULL
      RETURNING id
    `
    if (!claimed.length) return

    const mail = health.flapping ? operatorLoopMail(instance) : operatorStalledMail(instance)
    const sent = await sendAppEmail({ to, ...mail })
    if (!sent) {
      await sql`UPDATE app.instances SET ops_alerted_at = NULL WHERE id = ${instance.id}`
    }
    return
  }

  if (!instance.ops_alerted_at) return

  const sql = await appDb()
  // `IS NOT NULL`, not equality with the value read: rows come back as ISO
  // strings at millisecond precision, and the stored value has microseconds.
  const released = await sql`
    UPDATE app.instances SET ops_alerted_at = NULL
    WHERE id = ${instance.id} AND ops_alerted_at IS NOT NULL
    RETURNING id
  `
  if (!released.length || !to) return

  const sent = await sendAppEmail({ to, ...operatorLoopEndedMail(instance) })
  if (!sent) {
    await sql`
      UPDATE app.instances SET ops_alerted_at = ${instance.ops_alerted_at}
      WHERE id = ${instance.id} AND ops_alerted_at IS NULL
    `
  }
}

function operatorLoopMail(instance: AppInstance): AlertMail {
  return {
    subject: `WhatsApp connection ${instance.id} is stuck reconnecting`,
    text: [
      `Evolution keeps reopening the socket for WhatsApp connection ${instance.id} `
      + `(Evolution instance "${instance.name}", organization ${instance.org || 'unknown'}) `
      + 'while its stored status reads open: two sockets on one set of credentials are replacing each other.',
      '',
      `Seen since: ${instance.row_churn_since ?? 'just now'}`,
      '',
      'Fix: restart the Evolution service. No QR scan is needed; every account on it drops briefly and reconnects. '
      + 'Reconnect in the app cannot end this. Repeated logins can get the number flagged by WhatsApp, so do it soon.',
      ...(hostedMode()
        ? ['', 'The people using this connection are told it is on our side and that nothing is needed from them.']
        : []),
      '',
      'See docs/whatsapp.md, "Stuck reconnecting". You will get one more email when the loop has ended.',
    ].join('\n'),
  }
}

/**
 * A dead socket under a live `open` (#205): every call that needs the socket
 * fails with `Connection Closed` while `connectionState` and the column both say
 * `open`. Most likely the account's `eventProcessingQueue` is stuck — seen after
 * a Postgres restart failed Evolution's writes mid-event.
 */
function operatorStalledMail(instance: AppInstance): AlertMail {
  return {
    subject: `WhatsApp connection ${instance.id} is stuck: socket dead, state open`,
    text: [
      `WhatsApp connection ${instance.id} `
      + `(Evolution instance "${instance.name}", organization ${instance.org || 'unknown'}) `
      + 'reads open — live and stored — but its sends or group lookups fail with "Connection Closed", '
      + 'and Evolution has not reopened its socket since. Its session in Evolution is stuck: '
      + 'nothing is sent or received.',
      '',
      `Last failed socket call: ${instance.socket_dead_seen_at ?? 'just now'}`,
      '',
      'Fix: restart the Evolution service. No QR scan is needed; every account on it drops briefly and reconnects. '
      + 'Reconnect in the app cannot help (the state reads open), and /instance/restart must not be used. '
      + 'If Postgres was restarted recently, that is the likely cause.',
      ...(hostedMode()
        ? ['', 'The people using this connection are told it is on our side and that nothing is needed from them.']
        : []),
      '',
      'See docs/whatsapp.md, "Stuck with the socket dead". You will get one more email when it is working again.',
    ].join('\n'),
  }
}

/** Neutral about which it was: by the time it ends, the row no longer says. */
function operatorLoopEndedMail(instance: AppInstance): AlertMail {
  return {
    subject: `WhatsApp connection ${instance.id} is no longer stuck`,
    text: [
      `WhatsApp connection ${instance.id} (Evolution instance "${instance.name}") is no longer seen reconnecting over and over, `
      + 'nor with a dead socket under an open state. If Evolution has been unreachable since, this can also mean its row '
      + 'cannot be read; the connection\'s own outage mail covers that.',
    ].join('\n'),
  }
}

interface AlertRecipient {
  email: string
  /** An admin of the owning organization. Decides which fix the mail names. */
  canManage: boolean
}

function connectionUrl(instance: AppInstance): string | undefined {
  const appUrl = useRuntimeConfig().public.appUrl
  if (!appUrl) return undefined
  return `${appUrl.replace(/\/+$/, '')}/instances/${instance.id}`
}

function connectionLabel(instance: AppInstance, kind: ConnectionHealth['kind']): string {
  return instance.label?.trim() || (kind === 'telegram' ? 'your Telegram connection' : 'your WhatsApp connection')
}

/**
 * What the reader is asked to do differs on two axes, and both get it wrong in a
 * way that costs something real.
 *
 * **Which failure it is.** `sessionLost` means the phone is still linked and
 * Reconnect is enough; a connection that is not linked any more needs a QR scan.
 * The dashboard already draws that distinction, and getting it backwards sends
 * someone to re-pair a number that did not need it.
 *
 * **Who is reading.** Reconnecting and re-pairing are management, so a member
 * has neither button — `InstanceWhatsapp.vue` does not even enter pairing mode
 * for them. Telling them to press one is the failure the panel is careful to
 * avoid, reproduced in their inbox where nobody can see that the button is
 * missing. They are told what the state is and who can fix it instead.
 */
function outageMail(instance: AppInstance, health: ConnectionHealth, canManage: boolean): AlertMail {
  const label = connectionLabel(instance, health.kind)
  const url = connectionUrl(instance)

  // Not "disconnected": most reads find it connected, and some messages get
  // through. Saying it is down would be contradicted by the dashboard badge
  // the reader opens next.
  if (health.flapping) {
    return {
      subject: `${label} keeps reconnecting`,
      text: [
        `${label} is stuck reconnecting over and over, so anything connected to it — `
        + 'including MCP tools — may miss messages or fail to send.',
        '',
        whatsappLoopCause(instance, canManage),
        ...(url ? ['', url] : []),
        '',
        'You will get one more email when it is working again.',
      ].join('\n'),
    }
  }

  // Not "disconnected" either: every read says connected, and the dashboard
  // would contradict it. What is true is that nothing goes through.
  if (health.stalled) {
    return {
      subject: `${label} is not sending or receiving`,
      text: [
        `${label} reads as connected, but its connection to WhatsApp has stopped working, so anything `
        + 'connected to it — including MCP tools — cannot send, and new messages are not arriving.',
        '',
        whatsappStalledCause(instance, canManage),
        ...(url ? ['', url] : []),
        '',
        'You will get one more email when it is working again.',
      ].join('\n'),
    }
  }

  const cause = health.kind === 'telegram' ? telegramOutageCause(health, canManage) : whatsappOutageCause(health, canManage)

  return {
    subject: `${label} is disconnected`,
    text: [
      `${label} has stopped working, so anything connected to it — including MCP `
      + 'tools — cannot read or send messages right now.',
      '',
      cause,
      ...(url ? ['', url] : []),
      '',
      'You will get one more email when it is working again.',
    ].join('\n'),
  }
}

/**
 * Who can end a reconnect loop is whoever runs the Evolution service — never a
 * button in this app, since Reconnect does nothing to an `open` socket. On the
 * deployment's own server that is its operator, who on a self-hosted install is
 * likely the admin reading this. On a server the organization supplied, it is
 * them.
 *
 * On the hosted offering the operator is us, and the customer cannot restart
 * anything or reach whoever can. Telling them it is "worth doing soon" hands
 * them a problem they cannot act on. When `operatorAlertedAboutLoop` holds —
 * hosted, our server, and an operator address to mail — the operator has been
 * told already (`reportLoopToOperator` runs with no grace, so before this mail),
 * and the mail says so: nothing for the reader to do, admin or member.
 */
function whatsappLoopCause(instance: AppInstance, canManage: boolean): string {
  return evolutionStuckCause(instance, canManage,
    'Evolution keeps opening a new connection for this account and WhatsApp keeps replacing it.',
    ' Repeated logins can get a number flagged by WhatsApp, so this is worth doing soon.')
}

/**
 * A stuck session has the same fixer as a loop — whoever runs the Evolution
 * service — and the same hosted promise when `operatorAlertedAboutLoop` holds.
 * Never "press Reconnect": it answers 409 from `open`.
 */
function whatsappStalledCause(instance: AppInstance, canManage: boolean): string {
  return evolutionStuckCause(instance, canManage, 'Evolution\'s session for this account is stuck.')
}

/** The wording a loop and a stuck session share: who restarts Evolution, and the hosted promise. */
function evolutionStuckCause(instance: AppInstance, canManage: boolean, diagnosis: string, adminExtra = ''): string {
  if (operatorAlertedAboutLoop(instance)) {
    return `${diagnosis} This is on our side: we have been alerted and will restart the service. `
      + 'No QR scan is needed, the phone stays linked, and there is nothing you need to do.'
  }
  const service = onDeploymentServer(instance)
    ? 'whoever runs this deployment has to restart its Evolution service'
    : 'the Evolution server this connection uses has to be restarted'
  return canManage
    ? `${diagnosis} Reconnect cannot end this — ${service}. No QR scan is needed, and the phone stays linked.${adminExtra}`
    : `${diagnosis} Nothing needs scanning; ${service}, and an admin of your organization has been told as well.`
}

function whatsappOutageCause(health: ConnectionHealth, canManage: boolean): string {
  return health.sessionLost
    ? canManage
      ? 'The session dropped. The phone is still linked, so reconnecting should be '
        + 'enough — open the connection and press Reconnect. No QR scan needed.'
      : 'The session dropped. The phone is still linked, so an admin can bring it '
        + 'back with Reconnect — no QR scan needed.'
    : canManage
      ? 'The account is no longer linked. Open the connection and scan the QR code '
        + 'again to pair it.'
      : 'The account is no longer linked. An admin has to scan the QR code again '
        + 'to pair it.'
}

/**
 * Telegram has four distinct failures, and each has a different fix — or a
 * different person to fix it. A revocation needs a new QR link and says where it
 * came from, so nobody hunts for a bug; a dropped connection needs Reconnect and
 * explicitly no scan; and the two bridge problems are the operator's, so an admin
 * is pointed at the service rather than at a button that cannot help.
 */
function telegramOutageCause(health: ConnectionHealth, canManage: boolean): string {
  if (health.unreachable) {
    return canManage
      ? 'The Telegram bridge this connection runs on could not be reached. The account '
        + 'is not unlinked and nothing needs scanning — check that the bridge service is '
        + 'running and reachable from this app.'
      : 'The Telegram bridge this connection runs on could not be reached. The account '
        + 'is not unlinked and nothing needs scanning; an admin has been told as well.'
  }
  if (health.heldElsewhere) {
    return canManage
      ? 'Another copy of the Telegram bridge is holding this session, which usually '
        + 'means two copies are running at once (for example an overlapping deploy). '
        + 'Run the bridge as a single instance; nothing needs scanning.'
      : 'The Telegram bridge is misconfigured for this connection. Nothing needs '
        + 'scanning; an admin has been told as well.'
  }
  if (health.revoked) {
    return canManage
      ? 'Telegram ended the session — it was terminated under Telegram → Settings → '
        + 'Devices, or by Telegram itself. Open the connection and link it again by QR '
        + 'code. Chats synced so far are kept.'
      : 'Telegram ended the session — it was terminated under Telegram → Settings → '
        + 'Devices, or by Telegram itself. An admin has to link it again by QR code.'
  }
  if (health.sessionLost) {
    return canManage
      ? 'The connection to Telegram dropped. The account is still linked, so '
        + 'reconnecting should be enough — open the connection and press Reconnect. '
        + 'No QR scan needed.'
      : 'The connection to Telegram dropped. The account is still linked, so an admin '
        + 'can bring it back with Reconnect — no QR scan needed.'
  }
  return canManage
    ? 'The account is no longer linked. Open the connection and link it again by QR code.'
    : 'The account is no longer linked. An admin has to link it again by QR code.'
}

function recoveryMail(instance: AppInstance, health: ConnectionHealth): AlertMail {
  const label = connectionLabel(instance, health.kind)
  const url = connectionUrl(instance)

  return {
    subject: `${label} is connected again`,
    text: [
      `${label} is back. Reading and sending work again; nothing else is needed.`,
      ...(url ? ['', url] : []),
    ].join('\n'),
  }
}

/**
 * Everyone who can reach this connection, and so everyone for whom it breaking
 * is their problem: every admin of the owning organization, plus the members it
 * is assigned to.
 *
 * That set is not invented here — it is `authorizesInstance()` evaluated over
 * the roster, the same predicate the session and MCP surfaces decide access
 * with. Mailing a different set would mean a second definition of "reaches this
 * connection" that drifts from the one that grants it.
 *
 * `listOrgMembers` already carries each member's email, so this is two reads
 * whatever the size of the organization.
 */
async function recipientsFor(instance: AppInstance): Promise<AlertRecipient[]> {
  // The schema forbids it, but fail closed rather than mail an organization
  // resolved from an empty string.
  if (!instance.org) return []

  const [members, assignees] = await Promise.all([
    listOrgMembers(instance.org),
    listInstanceAssignees(instance.id),
  ])

  const assigned = new Set(assignees)

  return members
    .filter(member => authorizesInstance(
      { role: member.role, orgId: instance.org },
      instance.org,
      assigned.has(member.userId),
    ))
    .filter(member => Boolean(member.email))
    .map(member => ({ email: member.email, canManage: member.role === 'admin' }))
}

/**
 * Resolve the recipients and send. Answers whether the mail reached anyone.
 *
 * Recipients are resolved here rather than passed in because both callers hold
 * the instance and not a person, and because a connection whose organization has
 * emptied out should be skipped quietly rather than throw inside a sweep.
 *
 * One message each rather than one message with everyone in `to`: the recipients
 * are colleagues, not a mailing list, and putting a company's roster in a header
 * is a disclosure nobody asked for. "Reached anyone" is the bar for writing
 * `alerted_at` — one failed address must not queue a repeat to the others on
 * every sweep.
 */
async function notifyWatchers(
  instance: AppInstance,
  build: (canManage: boolean) => AlertMail,
): Promise<boolean> {
  let recipients: AlertRecipient[]

  try {
    recipients = await recipientsFor(instance)
  }
  catch (error) {
    console.error(`[alerts] could not resolve who to notify about connection ${instance.id}:`, error)
    return false
  }

  if (!recipients.length) {
    // Reachable: an organization whose only admin was removed, or a connection
    // assigned to nobody in an organization with no admin left. Worth a line —
    // the alert is computed and then has nowhere to go.
    console.error(`[alerts] connection ${instance.id} has nobody to notify; not sending "${build(true).subject}".`)
    return false
  }

  const results = await Promise.all(recipients.map((recipient) => {
    const mail = build(recipient.canManage)
    return sendAppEmail({ to: recipient.email, subject: mail.subject, text: mail.text })
  }))

  return results.some(Boolean)
}
