/**
 * One connection, with whatever "state" means for its kind.
 *
 * The kinds answer with different fields on purpose — a QR code and a profile
 * picture have no analogue for a database, and inventing one would make the
 * dashboard render an empty version of the wrong panel. `connectionState()`
 * owns that split; the page picks its panel from `instance.kind`.
 *
 * Not tolerant, unlike the listing: asked for one connection by id, a
 * half-provisioned row should say so rather than report a state it does not
 * have.
 *
 * `?fresh=counts` asks for message, chat and contact counts no older than a
 * couple of seconds instead of the few minutes they are otherwise cached for
 * (`getInstanceStatus`). Only the history-import screen after pairing sends it,
 * since it decides the import is over when the counts stop moving.
 *
 * A WhatsApp connection also carries `historyLimitedByPlan`: whether its plan
 * imports only recent history, so the dashboard can say so and offer Billing
 * instead of a full-history import the server would refuse. Decided by
 * `historyLimited`, not by the browser. A policy, not a fact about the
 * stored history — that is `recentHistoryOnly()`, which the MCP tools report.
 *
 * A Telegram connection carries it too: linking
 * it now would fetch only the last `TELEGRAM_RECENT_HISTORY_DAYS` days. The
 * fact for an account already linked is the bridge's `sync.historyDays`.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireReadableInstance(event, getRouterParam(event, 'id'))
  const freshCounts = getQuery(event).fresh === 'counts'

  const [state, historyLimitedByPlan] = await Promise.all([
    connectionState(instance, { freshCounts }),
    historyLimited(instance),
  ])

  return {
    instance: toPublicInstance(instance),
    ...state,
    ...(historyLimitedByPlan !== undefined && { historyLimitedByPlan }),
  }
})
