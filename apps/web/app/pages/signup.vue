<script setup lang="ts">
import { CheckIcon } from '@lucide/vue'

const { refresh } = useSession()
const route = useRoute()

const email = ref('')
const password = ref('')
const signupCode = ref('')
// Starts unticked, and is ticked once mounted only for a visitor outside the
// regions where a pre-ticked box is not consent (see marketingOptIn.ts). The
// lookup can take a moment, so a box the visitor already touched is left as
// they set it. The invitation signup form always starts unticked.
const marketingConsent = ref(false)
let marketingConsentTouched = false
function touchMarketingConsent() {
  marketingConsentTouched = true
}
onMounted(async () => {
  // `billing` is true exactly on the hosted offering, and is already resolved
  // here; the checkbox itself is hidden everywhere else.
  if (await marketingMayStartTicked({ lookup: billing.value }) && !marketingConsentTouched) {
    marketingConsent.value = true
  }
})
const error = ref('')
const busy = ref(false)

// How this deployment lets people sign up without an invitation. Unknown (the
// read failed) shows the form; the server decides either way.
const { data: policy } = await useFetch<{ selfSignup: 'open' | 'code' | 'closed', verification?: boolean, billing?: boolean }>('/api/auth/signup-policy')
const selfSignup = computed(() => policy.value?.selfSignup ?? 'open')

// Plans exist only on the hosted offering. Everywhere else `billing` is false
// and this page is exactly the form it always was.
type PlanChoice = 'free' | 'pro'
const billing = computed(() => Boolean(policy.value?.billing))
const queryPlan = route.query.plan
const plan = ref<PlanChoice | undefined>(queryPlan === 'free' || queryPlan === 'pro' ? queryPlan : undefined)
const choosingPlan = computed(() => billing.value && !plan.value)

const plans: { id: PlanChoice, name: string, price: string, note: string, features: string[] }[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    note: 'For trying it out on your own.',
    features: ['1 connection', '1 connector token', 'Just you', 'Recent WhatsApp history', 'Unlimited requests*'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$19/month',
    note: '7-day free trial. Card required; cancel any time before it ends.',
    features: [
      'Unlimited connections',
      'Unlimited connector tokens',
      '5 users included, $10/user/month after',
      'Full WhatsApp history',
      'Unlimited requests*',
    ],
  },
]
const chosen = computed(() => plans.find(p => p.id === plan.value))

async function submit() {
  error.value = ''
  busy.value = true
  try {
    const result = await $fetch<{ verificationRequired?: boolean, next?: 'checkout' }>('/api/auth/signup', {
      method: 'POST',
      body: {
        email: email.value,
        password: password.value,
        signupCode: selfSignup.value === 'code' ? signupCode.value : undefined,
        plan: billing.value ? plan.value : undefined,
        marketingConsent: marketingConsent.value,
      },
    })
    // With verification on, the account does not exist yet: the mailed code
    // creates it, and the verify page carries on to checkout.
    if (result.verificationRequired) return await navigateTo('/verify-email')
    await refresh()
    // Pro starts at Stripe. The account already exists on Free, so a failed
    // or abandoned checkout leaves a working account and the Billing page.
    if (result.next === 'checkout' && await startCheckout()) return
    await navigateTo(result.next === 'checkout' ? '/billing' : '/instances')
  }
  catch (err: any) {
    error.value = apiErrorMessage(err, 'Could not create the account')
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="choosingPlan && selfSignup !== 'closed'" class="mx-auto max-w-3xl py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Choose a plan
    </h1>
    <p class="mt-1 text-sm text-muted-foreground">
      You can start on Free and upgrade later.
    </p>

    <div class="mt-8 grid gap-4 sm:grid-cols-2">
      <div
        v-for="option in plans"
        :key="option.id"
        class="flex flex-col rounded-lg border p-6"
        :class="option.id === 'pro' ? 'border-primary' : ''"
      >
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="font-heading text-lg font-semibold">
            {{ option.name }}
          </h2>
          <span class="text-sm font-medium">{{ option.price }}</span>
        </div>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ option.note }}
        </p>
        <ul class="mt-4 flex-1 space-y-2 text-sm">
          <li v-for="feature in option.features" :key="feature" class="flex items-start gap-2">
            <CheckIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {{ feature }}
          </li>
        </ul>
        <Button
          class="mt-6 w-full"
          :variant="option.id === 'pro' ? 'default' : 'outline'"
          @click="plan = option.id"
        >
          {{ option.id === 'pro' ? 'Start 7-day trial' : 'Start free' }}
        </Button>
      </div>
    </div>
    <p class="mt-3 text-xs text-muted-foreground">
      * Subject to generous rate limits. Rate limits are to protect our servers from abuse.
    </p>

    <div class="mt-4 rounded-lg border border-dashed p-6 text-sm">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="font-heading text-base font-semibold">
          Self-hosted
        </h2>
        <span class="font-medium">Free, open source</span>
      </div>
      <p class="mt-1 text-muted-foreground">
        Run DOPE on your own infrastructure with no plan limits.
        Get the code on
        <a href="https://github.com/ju-li/automata-mcp" target="_blank" rel="noopener noreferrer" class="text-foreground underline underline-offset-4">GitHub</a>
        or deploy it in one click with the
        <a href="https://railway.com/deploy/automata-or-whatsapp-telegram-sql-mcp?referralCode=HxrUPo&utm_medium=integration&utm_source=template&utm_campaign=generic" target="_blank" rel="noopener noreferrer" class="text-foreground underline underline-offset-4">Railway template</a>.
      </p>
    </div>

    <p class="mt-6 text-center text-sm text-muted-foreground">
      Already have an account?
      <NuxtLink to="/login" class="text-foreground underline underline-offset-4">
        Sign in
      </NuxtLink>
    </p>
  </div>

  <div v-else class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Create an account
    </h1>
    <p v-if="billing && chosen && selfSignup !== 'closed'" class="mt-1 text-sm">
      {{ chosen.name }} plan
      <span class="text-muted-foreground">· {{ chosen.id === 'pro' ? '7-day trial, then $19/month' : 'free' }}</span>
      <button type="button" class="ml-1 text-muted-foreground underline underline-offset-4" @click="plan = undefined">
        Change
      </button>
    </p>
    <p v-if="selfSignup !== 'closed'" class="mt-1 text-sm text-muted-foreground">
      <template v-if="billing && plan === 'pro'">
        {{ policy?.verification
          ? 'We will email you a code to confirm the address, then you will add a card to start the trial.'
          : 'Next, you will add a card to start the trial.' }}
      </template>
      <template v-else>
        {{ policy?.verification
          ? 'We will email you a code to confirm the address first.'
          : 'You will add your first connection in the next step.' }}
      </template>
    </p>

    <p v-if="selfSignup === 'closed'" class="mt-8 text-sm text-muted-foreground">
      Sign-up on this deployment is by invitation. Ask an admin of your
      organization for an invitation link.
    </p>

    <form v-else class="mt-8 space-y-4" @submit.prevent="submit">
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input id="email" v-model="email" type="email" autocomplete="email" required />
      </div>

      <div class="space-y-2">
        <Label for="password">Password</Label>
        <Input id="password" v-model="password" type="password" autocomplete="new-password" minlength="8" required />
        <p class="text-xs text-muted-foreground">
          At least 8 characters.
        </p>
      </div>

      <div v-if="selfSignup === 'code'" class="space-y-2">
        <Label for="signup-code">Signup code</Label>
        <Input id="signup-code" v-model="signupCode" autocomplete="off" required />
        <p class="text-xs text-muted-foreground">
          This deployment needs a code to create an account. Joining an existing
          organization? Use the invitation link instead.
        </p>
      </div>

      <MarketingConsent v-model="marketingConsent" @update:model-value="touchMarketingConsent" />

      <p v-if="error" class="text-sm text-destructive">
        {{ error }}
      </p>

      <Button type="submit" class="w-full" :disabled="busy">
        {{ busy ? 'Creating…' : 'Create account' }}
      </Button>

      <LegalLinks agreement />
    </form>

    <p class="mt-6 text-center text-sm text-muted-foreground">
      Already have an account?
      <NuxtLink to="/login" class="text-foreground underline underline-offset-4">
        Sign in
      </NuxtLink>
    </p>
  </div>
</template>
