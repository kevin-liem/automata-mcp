import { assertNever } from '#shared/connection'
import type { ConnectionState } from '#shared/connection'

export type { ConnectionState }

export interface StateDisplay {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
  hint: string
}

/**
 * One place that maps a connection's state to what a person reads.
 *
 * The four states are shared by every kind so a badge needs no branching, but
 * the *hints* are kind-specific: "scan a QR code" is nonsense for a database,
 * and "not paired" is the wrong diagnosis for one that refused a login. The kind
 * is required — a default would put one kind's words on another's badge the
 * moment a caller forgot to pass it.
 *
 * "close" in particular needs translating — for a messaging account it means
 * "not paired", not "an error".
 *
 * Which is also why `lost` is an option rather than a fifth state. A session
 * that dropped is `close` or `connecting` like one that was never paired, and the
 * words for those — "scan a QR code" — are the wrong instruction for a phone that
 * is still linked. The server tells the two apart (`sessionLost`); this only
 * chooses what to say. `flapping` likewise: a reconnect loop reads `open`, and
 * only the server can tell it from a healthy connection — as is `stalled`, a
 * dead socket under an `open` that never wavers. `operatorAlerted`
 * (server-decided, hosted offering only) means the fix is the deployment's and
 * already under way, so the hint stops naming a restart the reader cannot do.
 */
export function describeState(
  state: ConnectionState,
  kind: InstanceKind,
  options: { lost?: boolean, flapping?: boolean, stalled?: boolean, operatorAlerted?: boolean } = {},
): StateDisplay {
  switch (kind) {
    case 'postgres':
      switch (state) {
        case 'open':
          return { label: 'Connected', variant: 'default', hint: 'Claude can query this database.' }
        case 'connecting':
          return { label: 'Connecting', variant: 'secondary', hint: 'Waiting for the database to answer.' }
        case 'close':
          return { label: 'Unreachable', variant: 'outline', hint: 'The database did not answer. Check the connection string and that this server can reach it.' }
        default:
          return { label: 'Unknown', variant: 'destructive', hint: 'No connection string is stored for this database.' }
      }

    case 'whatsapp':
      // Checked first: a loop reads `open` on most polls, and "Connected" over
      // it is the answer ju-li/automata-mcp#103 was about.
      if (options.flapping) {
        return {
          label: 'Unstable',
          variant: 'destructive',
          hint: options.operatorAlerted
            ? 'Evolution keeps reconnecting this account. Messages may be missed until we restart the service — we have been alerted, and there is nothing you need to do.'
            : 'Evolution keeps reconnecting this account. Messages may be missed until the Evolution service is restarted.',
        }
      }
      // Reads `open` everywhere and sends nothing (#205). Same fix as a loop.
      if (options.stalled) {
        return {
          label: 'Stuck',
          variant: 'destructive',
          hint: options.operatorAlerted
            ? 'Evolution\'s session for this account is stuck: nothing is sent or received until we restart the service — we have been alerted, and there is nothing you need to do.'
            : 'Evolution\'s session for this account is stuck: nothing is sent or received until the Evolution service is restarted.',
        }
      }
      if (options.lost && state !== 'open') {
        return {
          label: 'Connection lost',
          variant: 'destructive',
          // Reconnect is offered only from `close` (`reconnectInstance`), so
          // the other states name what does help instead.
          hint: state === 'close'
            ? 'WhatsApp dropped this account\'s connection. Evolution normally reconnects within seconds — if it stays like this, reconnect.'
            : 'WhatsApp dropped this account\'s connection. Evolution normally reconnects within seconds — if it stays like this, restart the Evolution service.',
        }
      }
      switch (state) {
        case 'open':
          return { label: 'Connected', variant: 'default', hint: 'This account can send and receive messages.' }
        case 'connecting':
          return { label: 'Waiting for scan', variant: 'secondary', hint: 'Scan the QR code with WhatsApp to finish pairing.' }
        case 'close':
          return { label: 'Disconnected', variant: 'outline', hint: 'Not paired with a phone. Scan a QR code to connect.' }
        default:
          return { label: 'Unknown', variant: 'destructive', hint: 'Could not reach the Evolution API for this account.' }
      }

    case 'telegram':
      if (options.lost && state !== 'open') {
        return {
          label: 'Connection lost',
          variant: 'destructive',
          hint: 'Telegram dropped this account\'s connection. The session is still linked — if it stays like this, reconnect.',
        }
      }
      switch (state) {
        case 'open':
          return { label: 'Connected', variant: 'default', hint: 'This account can send and receive messages.' }
        case 'connecting':
          return { label: 'Waiting for scan', variant: 'secondary', hint: 'In Telegram, open Settings → Devices → Link Desktop Device and scan the QR code.' }
        case 'close':
          return { label: 'Disconnected', variant: 'outline', hint: 'Not linked to a Telegram account. Scan a QR code to connect.' }
        default:
          return { label: 'Unknown', variant: 'destructive', hint: 'Could not reach the Telegram bridge for this account.' }
      }

    // The sync's last outcome, not a live login — see `getImapHealth`.
    case 'imap':
      switch (state) {
        case 'open':
          return { label: 'Syncing', variant: 'default', hint: 'Headers sync every two minutes; bodies and attachments are fetched when Claude asks.' }
        case 'connecting':
          return { label: 'First sync', variant: 'secondary', hint: 'The first sync is under way. Recent mail appears first.' }
        case 'close':
          return { label: 'Sync failing', variant: 'outline', hint: 'The last sync could not log in or reach the mail server.' }
        default:
          return { label: 'Stale', variant: 'destructive', hint: 'The mailbox has not synced recently.' }
      }

    default:
      return assertNever(kind, 'connection kind')
  }
}
