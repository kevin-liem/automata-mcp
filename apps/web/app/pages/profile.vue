<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * Your own account: display name, email address, password, two-factor
 * authentication (`TwoFactorSettings.vue`, which asks for the password itself).
 *
 * A page rather than a dialog: with two-factor settings underneath, the dialog
 * scrolled well past the viewport.
 *
 * Separate cards rather than one form, each with its own submit button and its
 * own busy flag. They are independent writes against separate routes, and a
 * shared flag would grey out the ones you are not using — the same reasoning
 * `McpTokens.vue` applies per row.
 *
 * Changing the email or the password asks for the current password. The session
 * cookie is `httpOnly` but a signed-in browser left open is enough to use it, so
 * the password is what separates "someone walked up to an unlocked laptop" from
 * "someone took the account". The server refuses a wrong one with a 403, never a
 * 401 — a 401 would read as being signed out mid-edit.
 */
const { user, refresh } = useSession()

// Both fields are edits of an existing value, not blank entries. Password fields
// start empty on every visit because the page mounts fresh.
const name = ref(user.value?.name ?? '')
const email = ref(user.value?.email ?? '')
const emailPassword = ref('')
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const mismatch = ref('')

// An address change waiting on its mailed code (email verification on). The old
// address stays the sign-in until it is confirmed.
const { data: pendingData, refresh: refreshPendingEmail } = await useFetch<{
  emailChangeDisabled: boolean
  pendingEmail: string | null
}>('/api/auth/email/pending')
const emailChangeDisabled = computed(() => pendingData.value?.emailChangeDisabled ?? false)
const pendingEmail = computed(() => pendingData.value?.pendingEmail ?? null)

const { busy: nameBusy, run: runName } = useApiAction()
const { busy: emailBusy, run: runEmail } = useApiAction()
const { busy: passwordBusy, run: runPassword } = useApiAction()

const nameChanged = computed(() => {
  const next = name.value.trim()
  return Boolean(next) && next !== (user.value?.name ?? '')
})

const emailChanged = computed(() => {
  const next = email.value.trim().toLowerCase()
  return Boolean(next) && next !== (user.value?.email ?? '').toLowerCase()
})

/**
 * Your name and address appear in places that fetched them separately — the
 * organization roster reads `/api/org`, not the session — so refreshing the
 * session alone leaves those showing the old value, which reads as the change
 * not having taken.
 */
async function refreshEverything() {
  await refresh()
  await refreshNuxtData()
}

/**
 * The credential routes report whether they managed to hand back a working
 * cookie. They answer 200 either way, because by then the change is committed and
 * failing the request would report "nothing happened" about something that did —
 * so the honest thing left to do is say so and send them to sign in again.
 */
async function settleSession(reauthenticated: boolean, changed: string): Promise<boolean> {
  if (reauthenticated) return true
  toast.warning(`${changed} Your session ended — please sign in again.`)
  await navigateTo('/login')
  return false
}

async function submitName() {
  if (!nameChanged.value) return

  await runName(async () => {
    await $fetch('/api/auth/profile', { method: 'PATCH', body: { name: name.value.trim() } })
    await refreshEverything()
  }, { success: 'Display name updated.', failure: 'Could not change the display name' })
}

async function submitEmail() {
  if (!emailChanged.value || !emailPassword.value) return

  const result = await runEmail(async () => {
    return await $fetch<{ email: string, reauthenticated: boolean, pending?: boolean, pendingEmail?: string }>('/api/auth/email', {
      method: 'PATCH',
      body: { email: email.value.trim(), currentPassword: emailPassword.value },
    })
  }, { failure: 'Could not change the email address' })

  if (!result) return
  if (result.pending) {
    emailPassword.value = ''
    email.value = user.value?.email ?? ''
    await refreshPendingEmail()
    toast.success(`We sent a code to ${result.pendingEmail}. Your address changes once you confirm it.`)
    await navigateTo('/verify-email')
    return
  }
  if (!await settleSession(result.reauthenticated, 'Email address changed.')) return

  emailPassword.value = ''
  await refreshEverything()
  toast.success(`Email address changed to ${result.email}.`)
}

async function cancelPendingEmail() {
  await runEmail(async () => {
    await $fetch('/api/auth/email/pending', { method: 'DELETE' })
    await refreshPendingEmail()
  }, { success: 'Pending address change cancelled.', failure: 'Could not cancel the change' })
}

async function submitPassword() {
  mismatch.value = ''
  if (!currentPassword.value || !newPassword.value) return
  if (newPassword.value !== confirmPassword.value) {
    // Never sent: the confirmation box is a typo guard here, and the server is
    // given one password rather than being asked to trust a comparison.
    mismatch.value = 'The two new passwords do not match.'
    return
  }

  const result = await runPassword(async () => {
    return await $fetch<{ reauthenticated: boolean }>('/api/auth/password', {
      method: 'PATCH',
      body: { currentPassword: currentPassword.value, password: newPassword.value },
    })
  }, { failure: 'Could not change the password' })

  if (!result) return
  if (!await settleSession(result.reauthenticated, 'Password changed.')) return

  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  toast.success('Password changed.')
}
</script>

<template>
  <div class="space-y-8">
    <div class="min-w-0">
      <h1 class="font-heading text-2xl font-semibold">
        Profile
      </h1>
      <p class="text-sm text-muted-foreground">
        Your account. Changing
        {{ emailChangeDisabled ? 'the password' : 'the email address or the password' }}
        asks for your current password.
      </p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Display name</CardTitle>
        <CardDescription>How colleagues see you on the organization page.</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="max-w-sm space-y-4" @submit.prevent="submitName">
          <div class="space-y-2">
            <Label for="profile-name">Name</Label>
            <Input
              id="profile-name"
              v-model="name"
              autocomplete="name"
              maxlength="100"
              :disabled="nameBusy"
            />
          </div>
          <Button type="submit" size="sm" :disabled="nameBusy || !nameChanged">
            {{ nameBusy ? 'Saving…' : 'Save' }}
          </Button>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Email address</CardTitle>
        <CardDescription v-if="emailChangeDisabled">
          Email changes are disabled for this deployment.
        </CardDescription>
        <CardDescription v-else>
          You sign in with this. A pending invitation sent to your old address
          will no longer be yours to accept.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div v-if="pendingEmail" class="max-w-sm rounded-md border p-3 text-sm">
          <p>
            Waiting for confirmation of <span class="font-medium">{{ pendingEmail }}</span>.
            Until then you keep signing in as {{ user?.email }}.
          </p>
          <div class="mt-3 flex gap-2">
            <Button as-child size="sm" variant="outline">
              <NuxtLink to="/verify-email">
                Enter code
              </NuxtLink>
            </Button>
            <Button size="sm" variant="ghost" :disabled="emailBusy" @click="cancelPendingEmail()">
              Cancel change
            </Button>
          </div>
        </div>

        <p v-if="emailChangeDisabled" class="break-all text-sm">
          {{ user?.email }}
        </p>
        <form v-else class="max-w-sm space-y-4" @submit.prevent="submitEmail">
          <div class="space-y-2">
            <Label for="profile-email">New address</Label>
            <Input
              id="profile-email"
              v-model="email"
              type="email"
              autocomplete="email"
              required
              :disabled="emailBusy"
            />
          </div>

          <div class="space-y-2">
            <Label for="profile-email-password">Current password</Label>
            <Input
              id="profile-email-password"
              v-model="emailPassword"
              type="password"
              autocomplete="current-password"
              required
              :disabled="emailBusy"
            />
          </div>

          <Button
            type="submit"
            size="sm"
            :disabled="emailBusy || !emailChanged || !emailPassword"
          >
            {{ emailBusy ? 'Changing…' : 'Change email' }}
          </Button>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Connector tokens are not affected — rotate a leaked token from its
          connection's page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form class="max-w-sm space-y-4" @submit.prevent="submitPassword">
          <div class="space-y-2">
            <Label for="profile-current-password">Current password</Label>
            <Input
              id="profile-current-password"
              v-model="currentPassword"
              type="password"
              autocomplete="current-password"
              required
              :disabled="passwordBusy"
            />
          </div>

          <div class="space-y-2">
            <Label for="profile-new-password">New password</Label>
            <Input
              id="profile-new-password"
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
              minlength="8"
              required
              :disabled="passwordBusy"
            />
            <p class="text-xs text-muted-foreground">
              At least 8 characters.
            </p>
          </div>

          <div class="space-y-2">
            <Label for="profile-confirm-password">Confirm new password</Label>
            <Input
              id="profile-confirm-password"
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              required
              :disabled="passwordBusy"
            />
            <p v-if="mismatch" class="text-xs text-destructive">
              {{ mismatch }}
            </p>
          </div>

          <Button
            type="submit"
            size="sm"
            :disabled="passwordBusy || !currentPassword || !newPassword || !confirmPassword"
          >
            {{ passwordBusy ? 'Changing…' : 'Change password' }}
          </Button>
        </form>
      </CardContent>
    </Card>

    <!-- No card header: the component carries its own heading and status line. -->
    <Card>
      <CardContent>
        <TwoFactorSettings />
      </CardContent>
    </Card>
  </div>
</template>
