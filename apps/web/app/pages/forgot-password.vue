<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * "Forgot password?": ask for a reset by address, then enter the mailed code
 * with a new password. The mail also carries a link to `/reset-password`, which
 * works in any browser; the code is for a mail read on another device, or one
 * sent without a link (no `NUXT_PUBLIC_APP_URL`).
 *
 * The server answers the same whether or not the address has an account, so
 * this page says "if", and never anything more. A reset signs nobody in: it
 * ends at the sign-in page, where a second factor is asked for as usual.
 * See server/utils/password-reset.ts.
 *
 * Reachable signed in and out: a member's admin-started reset mail can be read
 * anywhere.
 */
const route = useRoute()

const { data: availability } = await useFetch<{ available: boolean }>('/api/auth/password-reset')

const step = ref<'email' | 'code'>('email')
const email = ref(typeof route.query.email === 'string' ? route.query.email : '')
const code = ref('')
const password = ref('')
const confirm = ref('')

const { busy, run } = useApiAction()

const mismatch = computed(() => Boolean(confirm.value) && confirm.value !== password.value)

async function request() {
  const result = await run(async () => {
    return await $fetch<{ ok: true, email: string }>('/api/auth/password-reset', {
      method: 'POST',
      body: { email: email.value },
    })
  }, { failure: 'Could not ask for a password reset' })
  if (!result) return
  email.value = result.email
  step.value = 'code'
}

async function reset() {
  if (mismatch.value) return
  const result = await run(async () => {
    return await $fetch<{ ok: true, email: string }>('/api/auth/password-reset/code', {
      method: 'POST',
      body: { email: email.value, code: code.value.trim(), password: password.value },
    })
  }, { failure: 'Could not reset the password', keepBusyOnSuccess: true })

  if (!result) {
    code.value = ''
    return
  }
  toast.success('Password changed. Sign in with your new password.')
  await navigateTo({ path: '/login', query: { email: result.email } })
}
</script>

<template>
  <div class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Reset your password
    </h1>

    <div v-if="availability && !availability.available" class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        This deployment cannot send email, so passwords cannot be reset here.
        Ask an admin of your organization, or whoever runs this deployment, to
        reset it for you.
      </p>
      <Button as-child variant="outline">
        <NuxtLink to="/login">
          Back to sign in
        </NuxtLink>
      </Button>
    </div>

    <form v-else-if="step === 'email'" class="mt-8 space-y-4" @submit.prevent="request">
      <p class="text-sm text-muted-foreground">
        Enter the email address you sign in with. If it has an account, we’ll
        email it a link and a code to choose a new password.
      </p>

      <div class="space-y-2">
        <Label for="reset-email">Email</Label>
        <Input id="reset-email" v-model="email" type="email" autocomplete="email" required :disabled="busy" />
      </div>

      <Button type="submit" class="w-full" :disabled="busy || !email">
        {{ busy ? 'Sending…' : 'Email me a reset link' }}
      </Button>

      <p class="text-center text-sm text-muted-foreground">
        Already have a code?
        <button type="button" class="text-foreground underline underline-offset-4" @click="step = 'code'">
          Enter it
        </button>
      </p>
    </form>

    <form v-else class="mt-8 space-y-4" @submit.prevent="reset">
      <p class="text-sm text-muted-foreground">
        If <span class="font-medium text-foreground">{{ email || 'that address' }}</span> has an
        account, a link and a six-digit code are on their way. Open the link, or
        enter the code here. Both expire in 30 minutes.
      </p>

      <div class="space-y-2">
        <Label for="reset-code-email">Email</Label>
        <Input id="reset-code-email" v-model="email" type="email" autocomplete="username" required :disabled="busy" />
      </div>

      <div class="space-y-2">
        <Label for="reset-code">Code</Label>
        <Input
          id="reset-code"
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          pattern="\d{6}"
          required
          :disabled="busy"
        />
      </div>

      <div class="space-y-2">
        <Label for="reset-password">New password</Label>
        <Input id="reset-password" v-model="password" type="password" autocomplete="new-password" minlength="8" required :disabled="busy" />
      </div>

      <div class="space-y-2">
        <Label for="reset-confirm">Confirm new password</Label>
        <Input id="reset-confirm" v-model="confirm" type="password" autocomplete="new-password" required :disabled="busy" />
        <p v-if="mismatch" class="text-xs text-destructive">
          The passwords don’t match.
        </p>
      </div>

      <Button type="submit" class="w-full" :disabled="busy || code.trim().length !== 6 || password.length < 8 || confirm !== password">
        {{ busy ? 'Saving…' : 'Set new password' }}
      </Button>

      <p class="text-xs text-muted-foreground">
        Every browser signed in to the account is signed out. Connector tokens
        keep working. If the account uses two-factor authentication, you’ll
        still be asked for it when you sign in.
      </p>

      <p class="text-center text-sm text-muted-foreground">
        Nothing arrived?
        <button type="button" class="text-foreground underline underline-offset-4" @click="step = 'email'">
          Ask again
        </button>
      </p>
    </form>

    <p class="mt-6 text-center text-sm text-muted-foreground">
      <NuxtLink to="/login" class="text-foreground underline underline-offset-4">
        Back to sign in
      </NuxtLink>
    </p>
  </div>
</template>
