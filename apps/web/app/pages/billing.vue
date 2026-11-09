<script setup lang="ts">
import { CreditCardIcon, SparklesIcon } from '@lucide/vue'

/**
 * The organization's plan: what it is on, what it holds against the limits,
 * and the way to Stripe — Checkout to start Pro, the Customer Portal for the
 * card, invoices and cancelling.
 *
 * Exists only with billing on (the route answers 404 otherwise, and nothing
 * links here), and only for admins: `auth.global.ts` sends members elsewhere,
 * and the server refuses them regardless.
 *
 * Coming back from Checkout (`?checkout=success`) the plan may not have
 * changed yet — the organization becomes Pro when Stripe confirms it, not when
 * the browser returns. So this asks the server to re-read Stripe once, then
 * polls briefly for the webhook, rather than claiming success it cannot see.
 */
interface BillingResponse {
  plan: 'free' | 'pro'
  status: string | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  hasBillingAccount: boolean
  canStartTrial: boolean
  trialDays: number
  usage: { connections: number, tokens: number, members: number, pendingInvites: number }
  limits: { connections?: number, tokens?: number, members?: number } | null
  overLimit: boolean
  /** The cloud service could not be reached; usage and limits are still shown. */
  billingUnavailable?: boolean
  includedSeats: number
  billedSeats: number
}

const route = useRoute()
const { refresh: refreshSession } = useSession()
const { data, refresh, status: fetchStatus, error: fetchError } = await useFetch<BillingResponse>('/api/billing')
// Said in the page itself ("Could not load billing").
handlesErrorItself(fetchError)

const checkoutBusy = ref(false)
const { busy: portalBusy, run: runPortal } = useApiAction()
const confirming = ref(false)

async function checkout() {
  checkoutBusy.value = true
  if (!await startCheckout()) checkoutBusy.value = false
}

async function portal() {
  const result = await runPortal(
    () => $fetch<{ url: string }>('/api/billing/portal', { method: 'POST' }),
    { failure: 'Could not open billing', keepBusyOnSuccess: true },
  )
  if (result) window.location.assign(result.url)
}

onMounted(async () => {
  if (route.query.checkout !== 'success') return
  confirming.value = true
  try {
    await $fetch('/api/billing/sync', { method: 'POST' }).catch(() => {})
    for (let attempt = 0; attempt < 10; attempt++) {
      await refresh()
      if (data.value?.plan === 'pro') break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    await refreshSession()
  }
  finally {
    confirming.value = false
    await navigateTo({ query: {} }, { replace: true })
  }
})

const isPro = computed(() => data.value?.plan === 'pro')

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
}

const trialDaysLeft = computed(() => {
  const end = data.value?.trialEndsAt
  if (data.value?.status !== 'trialing' || !end) return undefined
  return Math.max(0, Math.ceil((new Date(end).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
})

const statusLine = computed(() => {
  const d = data.value
  if (!d) return ''
  if (d.plan === 'free') {
    return d.status ? 'Your subscription has ended, so this organization is on the Free plan.' : 'You are on the Free plan.'
  }
  if (d.status === 'trialing') {
    const left = trialDaysLeft.value
    const ends = formatDate(d.trialEndsAt)
    return d.cancelAtPeriodEnd
      ? `Your trial ends on ${ends} and will not renew.`
      : `${left} day${left === 1 ? '' : 's'} left in your trial. Your card is charged on ${ends}.`
  }
  if (d.status === 'past_due') {
    return 'Your last payment failed. Update your card to keep Pro.'
  }
  return d.cancelAtPeriodEnd
    ? `Pro ends on ${formatDate(d.currentPeriodEnd)} and will not renew.`
    : `Pro renews on ${formatDate(d.currentPeriodEnd)}.`
})

const meters = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { label: 'Connections', used: d.usage.connections, limit: d.limits?.connections },
    { label: 'Connector tokens', used: d.usage.tokens, limit: d.limits?.tokens },
    { label: 'Users', used: d.usage.members, limit: d.limits?.members },
  ]
})
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="font-heading text-2xl font-semibold">
        Billing
      </h1>
      <p class="text-sm text-muted-foreground">
        Your organization's plan and what it includes.
      </p>
    </div>

    <p v-if="confirming" class="text-sm text-muted-foreground">
      Confirming your subscription with Stripe…
    </p>

    <p v-if="fetchStatus === 'error'" class="text-sm text-destructive">
      Could not load billing. Try again in a moment.
    </p>

    <template v-if="data">
      <NoticeCard v-if="data.billingUnavailable" title="Billing is unavailable right now" tone="error">
        <template #description>
          <p class="mt-1 text-sm text-muted-foreground">
            Your plan and its limits still apply. Starting or managing a
            subscription will work again shortly.
          </p>
        </template>
      </NoticeCard>

      <NoticeCard v-if="data.overLimit" title="This organization is over the Free plan's limits">
        <template #description>
          <p class="mt-1 text-sm text-muted-foreground">
            Nothing has been deleted. Only one connector token — the oldest on
            your oldest connection — keeps working, and nothing new can be added
            until you upgrade or remove what is over the limit.
          </p>
        </template>
      </NoticeCard>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            {{ isPro ? 'Pro' : 'Free' }}
            <Badge v-if="data.status === 'trialing'" variant="secondary">
              Trial
            </Badge>
            <Badge v-else-if="data.status === 'past_due'" variant="destructive">
              Payment failed
            </Badge>
          </CardTitle>
          <CardDescription>{{ statusLine }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-6">
          <dl class="grid gap-4 sm:grid-cols-3">
            <div v-for="meter in meters" :key="meter.label" class="rounded-md border p-4">
              <dt class="text-xs text-muted-foreground">
                {{ meter.label }}
              </dt>
              <dd class="mt-1 text-lg font-medium" :class="meter.limit !== undefined && meter.used > meter.limit ? 'text-destructive' : ''">
                {{ meter.used }}<span v-if="meter.limit !== undefined" class="text-sm text-muted-foreground"> / {{ meter.limit }}</span>
              </dd>
            </div>
          </dl>

          <p v-if="isPro" class="text-sm text-muted-foreground">
            {{ data.includedSeats }} users are included.
            <template v-if="data.billedSeats">
              {{ data.billedSeats }} additional user{{ data.billedSeats === 1 ? '' : 's' }} billed at $10/month each.
            </template>
            <template v-else>
              Each user beyond that is $10/month.
            </template>
          </p>

          <div class="flex flex-wrap gap-2">
            <Button v-if="!isPro" :disabled="checkoutBusy" @click="checkout()">
              <SparklesIcon class="size-4" />
              {{ data.canStartTrial ? `Start ${data.trialDays}-day Pro trial` : 'Upgrade to Pro' }}
            </Button>
            <Button v-if="data.hasBillingAccount" variant="outline" :disabled="portalBusy" @click="portal()">
              <CreditCardIcon class="size-4" />
              Manage billing
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card v-if="!isPro">
        <CardHeader>
          <CardTitle>Pro</CardTitle>
          <CardDescription>
            $19/month{{ data.canStartTrial ? ` after a ${data.trialDays}-day free trial` : '' }}.
            A card is required to start; cancel any time from Manage billing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul class="list-disc space-y-1 pl-5 text-sm">
            <li>Unlimited connections and connector tokens</li>
            <li>{{ data.includedSeats }} users included, $10/user/month after</li>
            <li>Full WhatsApp history imported when you link an account</li>
            <li>Unlimited requests</li>
            <li>Telemetry optional, off by default</li>
          </ul>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
