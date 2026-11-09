<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * Proving an email address: after signing up, or after asking to change the
 * address on the profile page. See server/utils/email-verification.ts.
 *
 * Two ways in, and they need different things:
 *
 *   ?token=…   the link from the mail. Needs no cookie to prove the address,
 *              so it works on another device — but only the browser holding
 *              the pending cookie is signed in; any other is sent to sign in,
 *              so a forwarded link cannot sign someone into the sender's
 *              organization. Names the address (and, for an invitation, the
 *              organization and role) before Confirm. An invited signup or an
 *              address change is confirmable only in the browser that started
 *              it, so elsewhere the page says where to finish instead of
 *              offering Confirm. Spent only by
 *              the Confirm button, never on load — mail scanners open links,
 *              and opening one must not use it up.
 *   no token   the browser that started it, waiting for the six-digit code.
 *              The pending row is named by an httpOnly cookie, so what is
 *              pending is asked of the server rather than carried in the URL.
 *
 * Reachable signed in, signed out and without an organization: a signup is
 * signed out until this succeeds, and an address change is signed in.
 */
const route = useRoute()
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')

const { refresh } = useSession()

interface Pending { purpose: 'signup' | 'email_change', email: string }
interface LinkInfo extends Pending {
  invite?: { orgName: string, role: OrgRole }
  confirmableHere: boolean
}

const { data, status, refresh: refreshPending } = await useFetch<{ pending: Pending | null }>(
  '/api/auth/verify',
  // Client only: the cookie is scoped to /api/auth/verify, so the browser never
  // sends it with this page's own request and a server-side fetch would always
  // answer "nothing pending".
  { immediate: !token.value, server: false },
)
const pending = computed(() => data.value?.pending ?? null)

// What the link would confirm, read without spending it. Client only, like the
// pending read above: nothing about the token belongs in the SSR request.
const { data: link, status: linkStatus, error: linkError } = await useFetch<LinkInfo>('/api/auth/verify/link-info', {
  method: 'POST',
  body: { token },
  immediate: Boolean(token.value),
  server: false,
})
// A spent or expired link gets its own card below, not a toast.
handlesErrorItself(linkError)

const code = ref('')
const { busy, run } = useApiAction()
const { busy: resendBusy, run: runResend } = useApiAction()

async function finished(result: { purpose: Pending['purpose'], email: string, signedIn: boolean, next?: 'checkout' }) {
  await refresh()
  if (result.purpose === 'signup' && !result.signedIn) {
    // Confirmed in a browser other than the one that signed up: the address is
    // proved, but signing in here is the password's job.
    toast.success('Email confirmed. Sign in to continue.')
    await navigateTo('/login')
  }
  else if (result.purpose === 'signup' && result.next === 'checkout') {
    // Picked Pro on the signup page. The account exists on Free already, so a
    // failed or abandoned checkout still leaves the Billing page to retry from.
    toast.success('Email confirmed. Next, start your trial.')
    if (!await startCheckout()) await navigateTo('/billing')
  }
  else if (result.purpose === 'signup') {
    toast.success('Email confirmed. Welcome!')
    await navigateTo('/instances')
  }
  else {
    toast.success(`Your sign-in address is now ${result.email}.`)
    await refreshNuxtData()
    await navigateTo('/profile')
  }
}

async function submitCode() {
  const result = await run(async () => {
    return await $fetch<{ purpose: Pending['purpose'], email: string, signedIn: boolean, next?: 'checkout' }>('/api/auth/verify', {
      method: 'POST',
      body: { code: code.value.trim() },
    })
  }, { failure: 'Could not verify the code', keepBusyOnSuccess: true })

  if (result) await finished(result)
  else {
    code.value = ''
    // A fifth wrong code deletes the pending row; ask again so the page says so.
    await refreshPending()
  }
}

async function confirmLink() {
  const result = await run(async () => {
    return await $fetch<{ purpose: Pending['purpose'], email: string, signedIn: boolean, next?: 'checkout' }>('/api/auth/verify/link', {
      method: 'POST',
      body: { token: token.value },
    })
  }, { failure: 'Could not confirm the email address', keepBusyOnSuccess: true })

  if (result) await finished(result)
}

async function resend() {
  await runResend(async () => {
    await $fetch('/api/auth/verify/resend', { method: 'POST' })
  }, { success: 'A new code is on its way. The previous one no longer works.', failure: 'Could not send a new code' })
}
</script>

<template>
  <div class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Confirm your email
    </h1>

    <!-- The mailed link. -->
    <Skeleton v-if="token && (linkStatus === 'idle' || linkStatus === 'pending')" class="mt-8 h-40" />

    <div v-else-if="token && link && link.invite" class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        Confirm <span class="font-medium text-foreground">{{ link.email }}</span> as the sign-in
        address of a new account joining
        <span class="font-medium text-foreground">{{ link.invite.orgName }}</span>
        as {{ link.invite.role === 'admin' ? 'an admin' : 'a member' }}, with the password chosen at signup.
      </p>
      <p class="text-sm text-muted-foreground">
        Only confirm if you signed up with this address yourself. If you did not, close this
        page: someone holding your invitation link may be trying to join as you.
      </p>
      <p v-if="!link.confirmableHere" class="text-sm text-muted-foreground">
        This can only be confirmed in the browser where you signed up. Open the link there,
        or enter the code from the email on that browser's confirmation page.
      </p>
      <Button v-else class="w-full" :disabled="busy" @click="confirmLink()">
        {{ busy ? 'Confirming…' : 'Confirm email address' }}
      </Button>
    </div>

    <div v-else-if="token && link" class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        Confirm <span class="font-medium text-foreground">{{ link.email }}</span> as
        {{ link.purpose === 'signup' ? 'the sign-in address of a new account' : 'your new sign-in address' }}.
      </p>
      <p class="text-sm text-muted-foreground">
        {{ link.purpose === 'signup'
          ? 'Only confirm if you signed up with this address yourself. If you did not, close this page.'
          : 'Only confirm if you asked for this change yourself. If you did not, close this page.' }}
      </p>
      <p v-if="!link.confirmableHere" class="text-sm text-muted-foreground">
        This can only be confirmed in the browser where you asked for the change, signed in to
        that account. Open the link there, or enter the code from the email on that browser's
        confirmation page.
      </p>
      <Button v-else class="w-full" :disabled="busy" @click="confirmLink()">
        {{ busy ? 'Confirming…' : 'Confirm email address' }}
      </Button>
    </div>

    <div v-else-if="token" class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        This link has expired or was already used. Sign up again, or sign in if
        you already confirmed it.
      </p>
      <div class="flex gap-2">
        <Button as-child variant="outline">
          <NuxtLink to="/signup">
            Sign up again
          </NuxtLink>
        </Button>
        <Button as-child variant="outline">
          <NuxtLink to="/login">
            Sign in
          </NuxtLink>
        </Button>
      </div>
    </div>

    <Skeleton v-else-if="status === 'idle' || status === 'pending'" class="mt-8 h-40" />

    <!-- Waiting for the code. -->
    <form v-else-if="pending" class="mt-8 space-y-4" @submit.prevent="submitCode">
      <p class="text-sm text-muted-foreground">
        We sent a six-digit code to <span class="font-medium text-foreground">{{ pending.email }}</span>.
        Enter it here, or open the link in that email. It expires in 30 minutes.
      </p>

      <div class="space-y-2">
        <Label for="verify-code">Code</Label>
        <Input
          id="verify-code"
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          pattern="\d{6}"
          required
          :disabled="busy"
        />
      </div>

      <Button type="submit" class="w-full" :disabled="busy || code.trim().length !== 6">
        {{ busy ? 'Checking…' : 'Verify' }}
      </Button>

      <p class="text-center text-sm text-muted-foreground">
        Nothing arrived?
        <button
          type="button"
          class="text-foreground underline underline-offset-4 disabled:opacity-50"
          :disabled="resendBusy"
          @click="resend()"
        >
          Send a new code
        </button>
      </p>
    </form>

    <div v-else class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        There is nothing waiting to be confirmed in this browser. The code may have
        expired or been used, or you started in another browser — open the link
        from the email there instead.
      </p>
      <div class="flex gap-2">
        <Button as-child variant="outline">
          <NuxtLink to="/signup">
            Sign up again
          </NuxtLink>
        </Button>
        <Button as-child variant="outline">
          <NuxtLink to="/login">
            Sign in
          </NuxtLink>
        </Button>
      </div>
    </div>
  </div>
</template>
