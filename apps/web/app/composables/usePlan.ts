/**
 * The organization's plan, as `/api/auth/me` reported it.
 *
 * `plan` is the plan's display name, and `undefined` on a deployment without
 * the hosted offering — every self-hosted one — where nothing that reads this
 * may show a plan, a limit or a Billing link. `limited` says the organization
 * has limits at all; it knows numbers, not plan names.
 *
 * It gates UI only: every limit is enforced by the server, which answers 402
 * `plan_limit` whatever the browser shows.
 */
export function usePlan() {
  const { membership } = useSession()
  const plan = computed(() => membership.value?.org.plan)
  return {
    plan,
    billing: computed(() => Boolean(plan.value)),
    limited: computed(() => Boolean(membership.value?.org.limited)),
    overLimit: computed(() => Boolean(membership.value?.org.overLimit)),
    /** WhatsApp connections on this deployment's server may not import full history. */
    recentHistoryOnly: computed(() => Boolean(membership.value?.org.recentHistoryOnly)),
  }
}

/** The server refused because the plan has no room — `assertCanAdd` in entitlements.ts. */
export function isPlanLimitError(error: unknown): boolean {
  const body = (error as { data?: { data?: { code?: unknown } } })?.data
  return body?.data?.code === 'plan_limit'
}

/**
 * Toast a failed request with its details (`showErrorToast`), offering the
 * Billing page when the plan was the reason. Admins only get the link: a member
 * cannot upgrade, and a button they cannot use is worse than none. `isAdmin` is
 * read by the caller during setup — this runs in a `catch`, after an `await`,
 * where composables are unsafe.
 *
 * `fallback` is the toast's title — what was being attempted — and the
 * server's own diagnosis sits under it, so both are always shown.
 * `preferServerMessage: false` is for a server message that is worse than the
 * fallback ("Not found" for "Could not remove the account"): it is then left
 * out, and the status line under the title still says what happened.
 */
export function toastApiError(
  error: unknown,
  fallback: string,
  options: { preferServerMessage?: boolean, isAdmin?: boolean } = {},
): void {
  if (isPlanLimitError(error)) {
    // The plan-limit message is the whole story, and names the way out.
    showErrorToast(error, {
      title: apiErrorMessage(error, fallback),
      ...(options.isAdmin && { action: { label: 'See plans', onClick: () => navigateTo('/billing') } }),
    })
    return
  }
  showErrorToast(error, { title: fallback, hideServerMessage: options.preferServerMessage === false })
}

/** Send the browser to Stripe Checkout for Pro. Answers false when it could not. */
export async function startCheckout(): Promise<boolean> {
  try {
    const { url } = await $fetch<{ url: string }>('/api/billing/checkout', { method: 'POST' })
    window.location.assign(url)
    return true
  }
  catch (error) {
    showErrorToast(error, { title: 'Could not start checkout' })
    return false
  }
}
