export interface SessionUser {
  id: string
  email: string
  name?: string
}

export type OrgRole = 'admin' | 'member'

export interface SessionMembership {
  role: OrgRole
  /**
   * `plan` (a display name such as "Free" or "Pro (trial)"), `limited`,
   * `overLimit` and `recentHistoryOnly` are present only on the hosted
   * deployment; see usePlan().
   */
  org: { id: string, name: string, plan?: string, limited?: boolean, overLimit?: boolean, recentHistoryOnly?: boolean }
}

interface MeResponse {
  user: SessionUser | null
  membership?: SessionMembership | null
}

/**
 * The signed-in user and their organization, shared across the app.
 *
 * The browser never reads the session itself — the session cookie is `httpOnly`, so
 * the only way to know who is signed in is to ask the server. This caches that
 * answer in `useState` so it survives hydration and is fetched once per load
 * rather than once per navigation.
 *
 * `membership` comes back on the same request rather than from a second one:
 * the role decides what almost every page renders, so fetching it separately
 * would put an extra round-trip on every navigation.
 *
 * `isAdmin` gates UI only. Every action it hides is independently refused by the
 * server, and nothing here is a security boundary — a member who unhides a
 * button gets a 403, not an action.
 */
export function useSession() {
  const user = useState<SessionUser | null>('session:user', () => null)
  const membership = useState<SessionMembership | null>('session:membership', () => null)
  const loaded = useState<boolean>('session:loaded', () => false)

  async function refresh(): Promise<SessionUser | null> {
    // useRequestFetch forwards the incoming cookies during SSR; a bare $fetch
    // would make this request anonymously on the server and always see null.
    const fetchWithCookies = useRequestFetch()
    const { user: fetched, membership: fetchedMembership } = await fetchWithCookies<MeResponse>('/api/auth/me')
    user.value = fetched
    membership.value = fetchedMembership ?? null
    loaded.value = true
    return fetched
  }

  async function ensureLoaded(): Promise<SessionUser | null> {
    if (loaded.value) return user.value
    return await refresh()
  }

  async function logout(): Promise<void> {
    await $fetch('/api/auth/logout', { method: 'POST' })
    user.value = null
    membership.value = null
    loaded.value = true
    await navigateTo('/login')
  }

  return {
    user,
    membership,
    org: computed(() => membership.value?.org ?? null),
    role: computed(() => membership.value?.role ?? null),
    isAdmin: computed(() => membership.value?.role === 'admin'),
    hasOrg: computed(() => Boolean(membership.value)),
    loaded,
    refresh,
    ensureLoaded,
    logout,
  }
}
