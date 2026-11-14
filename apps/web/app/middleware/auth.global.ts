import { oauthReturnPath } from '~~/modules/mcp-oauth/shared'

const PUBLIC_ROUTES = new Set(['/login', '/signup'])

/** Reachable while signed in but belonging to no organization. */
const ORGLESS_ROUTE = '/no-organization'

/**
 * Your own account, reachable with or without an organization: changing a
 * password or adding a second factor must not wait on someone inviting you.
 */
const PROFILE_ROUTE = '/profile'

/** An invitation link is reachable signed out, signed in, and with no organization. */
function isInviteRoute(path: string): boolean {
  return path.startsWith('/invite/')
}

/**
 * Confirming an email address, the same: a signup is signed out until the code
 * comes back, an address change is signed in, and the mailed link may be opened
 * in any browser at all.
 */
const VERIFY_ROUTE = '/verify-email'

/**
 * Resetting a forgotten password, the same: asked for signed out, and the
 * mailed link may be opened in any browser — one signed in to another account
 * included, which a reset leaves signed in.
 */
const RESET_ROUTES = new Set(['/forgot-password', '/reset-password'])

/**
 * Session gate. Authentication, plus the two routing decisions that depend on
 * the organization.
 *
 * It deliberately does not look at a connection's live state — that would put an
 * Evolution round-trip, or a database connection, on every navigation.
 * `/instances` sends you to `/instances/new` when you have none, and the
 * per-connection page picks its panel from the connection's kind.
 *
 * The organization checks cost nothing extra: the role arrives on the same
 * `/api/auth/me` response the session already needs.
 *
 * **An invitation link escapes every redirect below.** Someone who has just been
 * removed from an organization, or who has never had one, must be able to open
 * one and accept it — bouncing them to the dead-end page would make the
 * invitation unusable by exactly the people it is for. It is also the one place
 * a signed-in user is not pushed off a public route, because accepting is what
 * they came to do.
 *
 * Role-based redirects, here and in the pages, are **convenience only**. Every
 * one of them is independently enforced server-side; unhiding a control in the
 * browser gets you a 403, not an action.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { user, hasOrg, isAdmin, membership, ensureLoaded } = useSession()
  await ensureLoaded()

  if (isInviteRoute(to.path) || to.path === VERIFY_ROUTE || RESET_ROUTES.has(to.path)) return

  const isPublic = PUBLIC_ROUTES.has(to.path)

  if (!user.value && !isPublic) {
    return navigateTo('/login')
  }

  if (user.value && isPublic) {
    const destination = oauthReturnPath(to.query.oauth_return)
    if (destination) return navigateTo(destination, { external: true })
    return navigateTo('/instances')
  }

  if (!user.value) return

  if (!hasOrg.value && to.path !== ORGLESS_ROUTE && to.path !== PROFILE_ROUTE) {
    return navigateTo(ORGLESS_ROUTE)
  }

  if (hasOrg.value && to.path === ORGLESS_ROUTE) {
    return navigateTo('/instances')
  }

  // Only an admin can create a connection, so the create flow is a dead end for
  // a member. The team page is not gated: a member seeing who the admins are is
  // what makes "ask an admin to assign you a connection" actionable.
  if (!isAdmin.value && to.path === '/instances/new') {
    return navigateTo('/instances')
  }

  // Billing is an admin's page, and exists only where plans do: a deployment
  // without billing reports no plan, and has no such page to show.
  if (to.path === '/billing' && (!isAdmin.value || !membership.value?.org.plan)) {
    return navigateTo('/instances')
  }
})
