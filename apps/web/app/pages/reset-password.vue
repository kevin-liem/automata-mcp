<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * The link from a password reset mail (`?token=…`). Names the account first
 * (`link-info`, which never spends the link), and spends it only when the
 * button is pressed — mail scanners open links, and opening one must not use
 * it up. Works in any browser; signs nobody in. See
 * server/utils/password-reset.ts.
 */
const route = useRoute()
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')

const { refresh } = useSession()

// Client only: nothing about the token belongs in the SSR request.
const { data: link, status, error } = await useFetch<{ email: string }>('/api/auth/password-reset/link-info', {
  method: 'POST',
  body: { token },
  immediate: Boolean(token.value),
  server: false,
})
// A spent or expired link gets its own card below, not a toast.
handlesErrorItself(error)

const password = ref('')
const confirm = ref('')
const { busy, run } = useApiAction()

const mismatch = computed(() => Boolean(confirm.value) && confirm.value !== password.value)

async function reset() {
  if (mismatch.value) return
  const result = await run(async () => {
    return await $fetch<{ ok: true, email: string }>('/api/auth/password-reset/link', {
      method: 'POST',
      body: { token: token.value, password: password.value },
    })
  }, { failure: 'Could not reset the password', keepBusyOnSuccess: true })
  if (!result) return

  // This browser may have been signed in to the account; that session ended.
  await refresh()
  toast.success('Password changed. Sign in with your new password.')
  await navigateTo({ path: '/login', query: { email: result.email } })
}
</script>

<template>
  <div class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Choose a new password
    </h1>

    <Skeleton v-if="token && (status === 'idle' || status === 'pending')" class="mt-8 h-40" />

    <form v-else-if="token && link" class="mt-8 space-y-4" @submit.prevent="reset">
      <p class="text-sm text-muted-foreground">
        Choose a new password for <span class="font-medium text-foreground">{{ link.email }}</span>.
      </p>

      <!-- For password managers: which account the new password belongs to. -->
      <input type="email" name="username" autocomplete="username" :value="link.email" class="hidden" readonly>

      <div class="space-y-2">
        <Label for="new-password">New password</Label>
        <Input id="new-password" v-model="password" type="password" autocomplete="new-password" minlength="8" required :disabled="busy" />
      </div>

      <div class="space-y-2">
        <Label for="confirm-password">Confirm new password</Label>
        <Input id="confirm-password" v-model="confirm" type="password" autocomplete="new-password" required :disabled="busy" />
        <p v-if="mismatch" class="text-xs text-destructive">
          The passwords don’t match.
        </p>
      </div>

      <Button type="submit" class="w-full" :disabled="busy || password.length < 8 || confirm !== password">
        {{ busy ? 'Saving…' : 'Set new password' }}
      </Button>

      <p class="text-xs text-muted-foreground">
        Every browser signed in to the account is signed out. Connector tokens
        keep working. If the account uses two-factor authentication, you’ll
        still be asked for it when you sign in.
      </p>
    </form>

    <div v-else class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        This link has expired or was already used. Ask for a new one.
      </p>
      <div class="flex gap-2">
        <Button as-child variant="outline">
          <NuxtLink to="/forgot-password">
            Ask for a new link
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
