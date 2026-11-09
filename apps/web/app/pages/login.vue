<script setup lang="ts">
import { startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'

/**
 * Two steps on one page. The password step signs in an account with no second
 * factor directly; one with a factor comes back with `mfaRequired` and the
 * methods it may answer with, and the session starts only once one of them
 * checks out (`/api/auth/login/verify`). The half-finished sign-in is a
 * server-side challenge behind an httpOnly cookie — nothing here holds it.
 */
type Method = 'totp' | 'webauthn' | 'recovery'

const { refresh } = useSession()
const route = useRoute()

// Prefilled after a password reset, which ends at this page.
const email = ref(typeof route.query.email === 'string' ? route.query.email : '')
const password = ref('')
const error = ref('')
const busy = ref(false)

// Hide "Create one" where it would lead to a page saying sign-up is closed.
const { data: signupPolicy } = await useFetch<{ selfSignup: 'open' | 'code' | 'closed' }>('/api/auth/signup-policy')

const step = ref<'password' | 'factor'>('password')
const methods = ref<Method[]>([])
const method = ref<Method>('totp')
const code = ref('')

async function finish() {
  await refresh()
  await navigateTo('/instances')
}

function errorCode(err: unknown): string | undefined {
  return (err as { data?: { data?: { code?: string } } })?.data?.data?.code
}

/** The challenge is gone (expired, or five wrong answers): back to the password. */
function restart(message: string) {
  step.value = 'password'
  password.value = ''
  code.value = ''
  error.value = message
}

async function submit() {
  error.value = ''
  busy.value = true
  try {
    const result = await $fetch<{ mfaRequired?: boolean, methods?: Method[] }>('/api/auth/login', {
      method: 'POST',
      body: { email: email.value, password: password.value },
    })
    if (result.mfaRequired) {
      methods.value = result.methods ?? []
      method.value = methods.value.includes('totp') ? 'totp' : methods.value.includes('webauthn') ? 'webauthn' : 'recovery'
      code.value = ''
      step.value = 'factor'
      return
    }
    await finish()
  }
  catch (err: any) {
    error.value = apiErrorMessage(err, 'Could not sign in')
  }
  finally {
    busy.value = false
  }
}

async function verify(body: Record<string, unknown>) {
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/auth/login/verify', { method: 'POST', body })
    await finish()
  }
  catch (err: any) {
    if (errorCode(err) === 'mfa_expired') restart(apiErrorMessage(err, 'Your sign-in expired. Enter your password again.'))
    else error.value = apiErrorMessage(err, 'Could not verify')
    code.value = ''
  }
  finally {
    busy.value = false
  }
}

async function submitCode() {
  if (!code.value.trim()) return
  await verify({ method: method.value, code: code.value.trim() })
}

async function usePasskey() {
  error.value = ''
  let response
  try {
    busy.value = true
    const optionsJSON = await $fetch<PublicKeyCredentialRequestOptionsJSON>('/api/auth/login/passkey-options', { method: 'POST' })
    response = await startAuthentication({ optionsJSON })
  }
  catch (err: any) {
    busy.value = false
    if (errorCode(err) === 'mfa_expired') return restart(apiErrorMessage(err, 'Your sign-in expired. Enter your password again.'))
    // The browser's own errors (cancelled, timed out) carry a name, not API data.
    error.value = err?.name === 'NotAllowedError'
      ? 'The passkey prompt was cancelled or timed out.'
      : apiErrorMessage(err, err?.message || 'Could not use a passkey')
    return
  }
  await verify({ method: 'webauthn', response })
}

function choose(next: Method) {
  method.value = next
  code.value = ''
  error.value = ''
}
</script>

<template>
  <div class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Sign in
    </h1>
    <p class="mt-1 text-sm text-muted-foreground">
      {{ step === 'password' ? 'Connect WhatsApp and databases to Claude.' : 'Two-factor authentication is on for this account.' }}
    </p>

    <form v-if="step === 'password'" class="mt-8 space-y-4" @submit.prevent="submit">
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input id="email" v-model="email" type="email" autocomplete="email" required />
      </div>

      <div class="space-y-2">
        <div class="flex items-baseline justify-between gap-2">
          <Label for="password">Password</Label>
          <NuxtLink
            :to="email ? { path: '/forgot-password', query: { email } } : '/forgot-password'"
            class="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Forgot password?
          </NuxtLink>
        </div>
        <Input id="password" v-model="password" type="password" autocomplete="current-password" required />
      </div>

      <p v-if="error" class="text-sm text-destructive">
        {{ error }}
      </p>

      <Button type="submit" class="w-full" :disabled="busy">
        {{ busy ? 'Signing in…' : 'Sign in' }}
      </Button>
    </form>

    <div v-else class="mt-8 space-y-4">
      <div v-if="method === 'webauthn'" class="space-y-4">
        <p class="text-sm">
          Use the passkey or security key you added to this account.
        </p>
        <Button type="button" class="w-full" :disabled="busy" @click="usePasskey">
          {{ busy ? 'Waiting for passkey…' : 'Use passkey' }}
        </Button>
      </div>

      <form v-else class="space-y-4" @submit.prevent="submitCode">
        <div class="space-y-2">
          <Label for="code">{{ method === 'totp' ? 'Code from your authenticator app' : 'Recovery code' }}</Label>
          <Input
            id="code"
            v-model="code"
            :inputmode="method === 'totp' ? 'numeric' : 'text'"
            :autocomplete="method === 'totp' ? 'one-time-code' : 'off'"
            :placeholder="method === 'totp' ? '123456' : 'xxxx-xxxx-xxxx'"
            autofocus
            required
          />
          <p v-if="method === 'recovery'" class="text-xs text-muted-foreground">
            Each recovery code works once.
          </p>
        </div>
        <Button type="submit" class="w-full" :disabled="busy || !code.trim()">
          {{ busy ? 'Checking…' : 'Verify' }}
        </Button>
      </form>

      <p v-if="error" class="text-sm text-destructive">
        {{ error }}
      </p>

      <div class="flex flex-col gap-1 text-sm">
        <button v-if="method !== 'totp' && methods.includes('totp')" type="button" class="text-left underline underline-offset-4" @click="choose('totp')">
          Use your authenticator app
        </button>
        <button v-if="method !== 'webauthn' && methods.includes('webauthn')" type="button" class="text-left underline underline-offset-4" @click="choose('webauthn')">
          Use a passkey or security key
        </button>
        <button v-if="method !== 'recovery' && methods.includes('recovery')" type="button" class="text-left underline underline-offset-4" @click="choose('recovery')">
          Use a recovery code
        </button>
        <button type="button" class="text-left text-muted-foreground underline underline-offset-4" @click="restart('')">
          Back
        </button>
      </div>
    </div>

    <p v-if="step === 'password' && signupPolicy?.selfSignup !== 'closed'" class="mt-6 text-center text-sm text-muted-foreground">
      No account?
      <NuxtLink to="/signup" class="text-foreground underline underline-offset-4">
        Create one
      </NuxtLink>
    </p>
  </div>
</template>
