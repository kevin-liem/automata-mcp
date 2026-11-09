import type { AppUser } from '~~/server/utils/app-db'

/**
 * Current session, or `{ user: null }`. Deliberately not a 401: the client
 * middleware calls this on every navigation to decide where to send the user,
 * and an error response would make "signed out" indistinguishable from "the
 * request failed".
 *
 * The organization comes back with it, because every page needs the role and
 * fetching it separately would mean a second round-trip on every navigation.
 *
 * `membership: null` is a real, reachable answer and not an error: a record
 * whose organization was deleted, or one created before this existed. This route
 * therefore does NOT use `requireMembership`, which throws — it reports the
 * state and lets the client route somewhere that explains it. A backend fault
 * still becomes a 503, so an outage is never mistaken for "you were removed".
 */
/**
 * The plan's name and the organization's standing against its limits, so
 * every page can show the Billing link, limits and the over-limit banner
 * without asking again. Nothing at all without the hosted offering — no query,
 * no field — so a self-hosted UI never learns plans exist. A read failure is a
 * 503 like the membership read.
 */
async function planSummary(orgId: string): Promise<{ plan: string, limited: boolean, overLimit: boolean, recentHistoryOnly: boolean } | undefined> {
  if (!hostedMode()) return undefined
  try {
    const sql = await appDb()
    const [[org], limits, usage] = await Promise.all([
      sql<{ plan_label?: string }[]>`SELECT plan_label FROM app.organizations WHERE id = ${orgId}`,
      loadOrgLimits(sql, orgId),
      orgUsage(sql, orgId),
    ])
    return {
      plan: org?.plan_label ?? 'Free',
      limited: hasLimits(limits),
      overLimit: overLimit(limits, usage),
      // Whether the create form may offer a full WhatsApp history import on
      // this deployment's server. The server refuses it independently.
      recentHistoryOnly: limits?.recent_history_only === true,
    }
  }
  catch (error) {
    console.error('[entitlements] could not read the plan for organization', orgId, error)
    throw appDbUnavailable(error)
  }
}

export default defineEventHandler(async (event) => {
  const user = event.context.user as AppUser | undefined
  if (!user) return { user: null }

  const actor = await loadActor(user)
  const plan = actor ? await planSummary(actor.org.id) : undefined

  return {
    user: { id: user.id, email: user.email, name: user.name },
    membership: actor
      ? { role: actor.role, org: { id: actor.org.id, name: actor.org.name, ...plan } }
      : null,
  }
})
