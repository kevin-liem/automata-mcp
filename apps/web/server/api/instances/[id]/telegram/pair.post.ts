/**
 * Start linking a Telegram account by QR code.
 *
 * Explicit, never on page load: pairing binds a real account, so it starts only
 * when an admin asks. Idempotent while a flow is already running; the bridge
 * abandons a flow nobody completes within five minutes. The history cap the
 * plan calls for travels with the request — see `startTelegramPairing`.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  try {
    return pairingView(await startTelegramPairing(instance))
  }
  catch (error) {
    relayBridgeError(error, 'start pairing')
  }
})
